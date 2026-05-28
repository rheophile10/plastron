import { test, beforeEach, afterAll } from "bun:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";

// notepad-app — the minimal text-editor application built on shipped segments
// (html-template + plastron-dom + the {set,extract} event binding + file-store).
// buildNotepad generates the application segment; installNotepadActions wires
// the fs-backed save/load. See docs/3-test-design/05-runCycle/notepad-app.md.

process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs-notepad";

const {
  createInitialState, precomputeOptional, resolveFn,
  buildNotepad, installNotepadActions, createPainter, setPainter,
} = await import("../dist/index.js");
const { makeListener } = await import("../dist/甲骨坑/dom/events.js");

// ── file-store cleanup (node-fs backend, env-rooted) ────────────────────────
const activeRoot = createInitialState().cels.get("file-store.root").v;
const wipe = async () => { await fs.rm(path.resolve(activeRoot), { recursive: true, force: true }); };
beforeEach(wipe);
afterAll(wipe);

// ── helpers ──────────────────────────────────────────────────────────────────
const bootNotepad = async (opts) => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const seg = buildNotepad(opts);
  await hydrate(state, [seg], [seg]);
  await precomputeOptional(state);
  return state;
};
const v = (state, key) => state.cels.get(key)?.v;
const findTag = (vn, tag) => {
  if (!vn) return undefined;
  if (vn.type === "el" && vn.tag === tag) return vn;
  for (const c of vn.children ?? []) { const f = findTag(c, tag); if (f) return f; }
  return undefined;
};
const allTag = (vn, tag, acc = []) => {
  if (!vn) return acc;
  if (vn.type === "el" && vn.tag === tag) acc.push(vn);
  for (const c of vn.children ?? []) allTag(c, tag, acc);
  return acc;
};

// rAF + structural fake DOM (shape borrowed from raf-channel.test.mjs).
const mockRaf = () => {
  const q = [];
  return { raf: (cb) => q.push(cb), caf: () => {}, run: () => { for (const cb of q.splice(0)) cb(); } };
};
const makeDoc = () => {
  const mkEl = (tag) => {
    const listeners = new Map();
    return {
      nodeType: 1, tag, tagName: tag.toUpperCase(), value: undefined,
      childNodes: [], attributes: {}, _listeners: listeners,
      style: { props: {}, setProperty(p, x) { this.props[p] = x; }, removeProperty(p) { delete this.props[p]; } },
      get firstChild() { return this.childNodes[0] ?? null; },
      get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; },
      setAttribute(n, x) { this.attributes[n] = x; },
      removeAttribute(n) { delete this.attributes[n]; },
      appendChild(c) { this.childNodes.push(c); return c; },
      removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); return c; },
      replaceChild(n2, o) { const i = this.childNodes.indexOf(o); if (i >= 0) this.childNodes[i] = n2; return o; },
      insertBefore(n2, ref) { const i = ref ? this.childNodes.indexOf(ref) : -1; if (i >= 0) this.childNodes.splice(i, 0, n2); else this.childNodes.push(n2); return n2; },
      replaceChildren(...c) { this.childNodes = [...c]; },
      addEventListener(t, fn) { (listeners.get(t) ?? listeners.set(t, new Set()).get(t)).add(fn); },
      removeEventListener(t, fn) { listeners.get(t)?.delete(fn); },
    };
  };
  return { createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }) };
};
const findPainted = (node, TAG) => {
  if (!node) return undefined;
  if (node.tagName === TAG) return node;
  for (const c of node.childNodes ?? []) { const f = findPainted(c, TAG); if (f) return f; }
  return undefined;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── 1. the view: a textarea bound to the text cel ────────────────────────────

test("buildNotepad renders a textarea bound to notepad.text with a {set,extract} input binding", async () => {
  const state = await bootNotepad({ text: "hello" });
  assert.equal(state.segments.get("notepad").role, "application", "notepad is a role:application segment");

  await resolveFn(state, "runCycle")(state);
  const spec = v(state, "notepad.view");
  assert.equal(spec.mount, "#notepad", "mount comes from the reserved input");

  const textarea = findTag(spec.vnode, "textarea");
  assert.ok(textarea, "a <textarea> is rendered");
  assert.equal(textarea.attrs.value, "hello", "textarea value mirrors notepad.text");
  assert.deepEqual(textarea.events.input, { set: "notepad.text", extract: "value" },
    "onInput is the controlled-input binding the painter writes back through");

  const [save, load] = allTag(spec.vnode, "button");
  assert.deepEqual(save.events.click, { f: "(dispatch notepad.save)" }, "Save dispatches the persist action");
  assert.deepEqual(load.events.click, { f: "(dispatch notepad.load)" }, "Load dispatches the restore action");
});

// ── 2. edits round-trip: typing updates the cel; the cel re-renders ──────────

test("the input binding writes event.target.value into notepad.text and the view re-renders", async () => {
  const state = await bootNotepad({ text: "" });
  const runCycle = resolveFn(state, "runCycle");
  await runCycle(state);
  assert.equal(findTag(v(state, "notepad.view").vnode, "textarea").attrs.value, "");

  // The real listener the painter would attach for the binding, fired with a
  // synthetic input event — exactly the keystroke path.
  const handler = makeListener(findTag(v(state, "notepad.view").vnode, "textarea").events.input, state);
  handler({ type: "input", target: { value: "typed in the box" } });
  await tick(); // set is async (fire-and-forget inside the handler)
  assert.equal(v(state, "notepad.text"), "typed in the box", "cel updated from event.target.value");

  await runCycle(state);
  assert.equal(findTag(v(state, "notepad.view").vnode, "textarea").attrs.value, "typed in the box",
    "view re-rendered with the new value");
});

// ── 3. save / load: persist the note and restore it (file-store round-trip) ──

test("notepad.save persists the note and notepad.load restores it", async () => {
  const state = await bootNotepad({ text: "draft to keep", path: "notes/keep.txt" });
  await installNotepadActions(state);
  await resolveFn(state, "runCycle")(state);

  await resolveFn(state, "notepad.save")(state);
  assert.equal(await resolveFn(state, "fs.exists")("notes/keep.txt"), true, "save wrote the note file");

  await resolveFn(state, "set")(state, "notepad.text", "");
  assert.equal(v(state, "notepad.text"), "", "note cleared");

  await resolveFn(state, "notepad.load")(state);
  assert.equal(v(state, "notepad.text"), "draft to keep", "load restored the saved note");

  await resolveFn(state, "runCycle")(state);
  assert.equal(findTag(v(state, "notepad.view").vnode, "textarea").attrs.value, "draft to keep",
    "the view reflects the loaded note");
});

test("notepad.load is a no-op when nothing was saved", async () => {
  const state = await bootNotepad({ text: "unsaved", path: "notes/missing.txt" });
  await installNotepadActions(state);
  await resolveFn(state, "notepad.load")(state); // must not throw
  assert.equal(v(state, "notepad.text"), "unsaved", "text untouched when there is no file to load");
});

// ── 4. standalone: paints the textarea into its mount target ─────────────────

test("standalone: the view paints into its mount via the plastron-dom.paint channel", async () => {
  const state = await bootNotepad({ text: "mounted", mount: "#root" });
  const m = mockRaf();
  const doc = makeDoc();
  const root = doc.createElement("root");
  setPainter(state, createPainter(state, { raf: m.raf, caf: m.caf, isBrowser: true, doc, resolveMount: () => root }));

  await resolveFn(state, "runCycle")(state);
  await resolveFn(state, "drain")(state, "plastron-dom.paint");
  m.run();

  assert.equal(root.childNodes.length, 1, "the view tree mounted into the target");
  const textarea = findPainted(root.childNodes[0], "TEXTAREA");
  assert.ok(textarea, "textarea painted into the DOM");
  assert.equal(textarea.value, "mounted", "textarea.value set from notepad.text");
});
