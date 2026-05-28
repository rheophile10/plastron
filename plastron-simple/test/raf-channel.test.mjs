import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn } from "../dist/index.js";
import { diffVNodes } from "../dist/甲骨坑/dom/diff.js";
import { createPainter, setPainter, getPainter } from "../dist/甲骨坑/dom/paint.js";

// raf-channel — the painter consumes render-specs through a RAF-batched
// ChannelCel, diffs vnode trees to JSON patches, applies them to the DOM
// (browser only), and reconciles the global listener registry. Off-browser
// the patch is produced + observable but DOM mutation is skipped.
// See docs/3-test-design/05-runCycle/raf-channel.md.

const userManifest = { name: "user", version: "0.0.1", dependencies: [] };

const txt = (t) => ({ type: "text", text: t });
const el = (tag, opts = {}, ...children) => ({ type: "el", tag, ...opts, ...(children.length ? { children } : {}) });
const spec = (vnode, mount = null, listeners = []) => ({ vnode, mount, listeners });

// Mock rAF: a queue the test drains manually.
const mockRaf = () => {
  const q = [];
  return { raf: (cb) => q.push(cb), caf: () => {}, run: () => { const cbs = q.splice(0); for (const cb of cbs) cb(); }, size: () => q.length };
};

// Compact structural fake DOM, enough for applyPatch + the leak accounting.
const makeDoc = () => {
  const els = new Set();
  const mkEl = (tag) => {
    const listeners = new Map();
    const node = {
      nodeType: 1, tag, tagName: tag.toUpperCase(), value: undefined,
      childNodes: [], attributes: {}, _listeners: listeners,
      style: { props: {}, setProperty(p, v) { this.props[p] = v; }, removeProperty(p) { delete this.props[p]; } },
      get firstChild() { return this.childNodes[0] ?? null; },
      get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; },
      setAttribute(n, v) { this.attributes[n] = v; },
      removeAttribute(n) { delete this.attributes[n]; },
      appendChild(c) { this.childNodes.push(c); return c; },
      removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); return c; },
      replaceChild(n2, o) { const i = this.childNodes.indexOf(o); if (i >= 0) this.childNodes[i] = n2; return o; },
      insertBefore(n2, ref) { const i = ref ? this.childNodes.indexOf(ref) : -1; if (i >= 0) this.childNodes.splice(i, 0, n2); else this.childNodes.push(n2); return n2; },
      replaceChildren(...c) { this.childNodes = [...c]; },
      addEventListener(t, fn) { (listeners.get(t) ?? listeners.set(t, new Set()).get(t)).add(fn); },
      removeEventListener(t, fn) { listeners.get(t)?.delete(fn); },
    };
    els.add(node);
    return node;
  };
  return {
    doc: { createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }) },
    liveListeners() { let n = 0; for (const e of els) for (const s of e._listeners.values()) n += s.size; return n; },
  };
};

const fakeTarget = () => {
  const map = new Map();
  return {
    map,
    addEventListener(t, fn) { (map.get(t) ?? map.set(t, new Set()).get(t)).add(fn); },
    removeEventListener(t, fn) { map.get(t)?.delete(fn); },
    fire(t, ev = {}) { for (const fn of [...(map.get(t) ?? [])]) fn({ type: t, ...ev }); },
    liveCount() { let n = 0; for (const s of map.values()) n += s.size; return n; },
  };
};

// ── diffVNodes (pure) ───────────────────────────────────────────────────────

test("diffVNodes core kinds: init / noop / replace / text / el", () => {
  assert.equal(diffVNodes(null, el("div")).kind, "init");
  const same = el("div", {}, txt("a"));
  assert.equal(diffVNodes(same, same).kind, "noop", "ref-eq bail");
  assert.equal(diffVNodes(el("div", {}, txt("a")), el("div", {}, txt("a"))).kind, "noop", "structural equal bail");
  assert.equal(diffVNodes(el("div"), el("span")).kind, "replace", "tag change");
  assert.deepEqual(diffVNodes(txt("a"), txt("b")), { kind: "text", text: "b" });

  const p = diffVNodes(el("div", { attrs: { a: "1" } }), el("div", { attrs: { a: "2", b: "x" } }));
  assert.equal(p.kind, "el");
  assert.deepEqual(p.attrs, { set: { a: "2", b: "x" } });
});

test("diffVNodes keyed reconcile on reorder; degrades to positional in place", () => {
  const a = el("li", { key: "a" }, txt("A"));
  const b = el("li", { key: "b" }, txt("B"));
  const c = el("li", { key: "c" }, txt("C"));
  // Reorder [a,b,c] -> [c,a,b] with ref-stable subtrees.
  const patch = diffVNodes(el("ul", {}, a, b, c), el("ul", {}, c, a, b));
  assert.equal(patch.kind, "el");
  const recon = patch.children.find((o) => o.op === "reconcile");
  assert.ok(recon, "fully-keyed reorder → reconcile op");
  assert.deepEqual(recon.entries.map((e) => e.fromIndex), [2, 0, 1], "matched by key");
  assert.ok(recon.entries.every((e) => e.kind === "keep" && e.patch.kind === "noop"),
    "ref-stable subtrees → noop sub-patches (subtree bail-out)");

  // Same order, one child changed → positional, not reconcile.
  const b2 = el("li", { key: "b" }, txt("B!"));
  const inPlace = diffVNodes(el("ul", {}, a, b, c), el("ul", {}, a, b2, c));
  assert.ok(!inPlace.children.some((o) => o.op === "reconcile"), "in-place keyed → positional");
  assert.equal(inPlace.children.length, 1, "only the changed child is patched");
  assert.equal(inPlace.children[0].op, "patch");
  assert.equal(inPlace.children[0].index, 1, "the b row");
  // The <li> wraps the text, so its patch is an el patch with a nested text patch.
  assert.deepEqual(inPlace.children[0].patch.children, [{ op: "patch", index: 0, patch: { kind: "text", text: "B!" } }]);
});

// ── painter: RAF batching + off-browser patch ───────────────────────────────

test("N enqueues across mounts coalesce into ONE rAF flush", () => {
  const state = createInitialState();
  const m = mockRaf();
  const painter = createPainter(state, { raf: m.raf, caf: m.caf, isBrowser: false });
  painter.enqueue(spec(el("div", {}, txt("a")), "#a"));
  painter.enqueue(spec(el("div", {}, txt("b")), "#b"));
  painter.enqueue(spec(el("div", {}, txt("c")), "#c"));
  assert.equal(m.size(), 1, "three enqueues → one scheduled frame");
  m.run();
  assert.equal(painter.lastPatch("#a").kind, "init");
  assert.equal(painter.lastPatch("#c").kind, "init");
  assert.equal(painter.pending(), false, "frame consumed");
});

test("off-browser: patch is produced + observable, no DOM mutation", () => {
  const state = createInitialState();
  const m = mockRaf();
  const painter = createPainter(state, { raf: m.raf, caf: m.caf, isBrowser: false });
  painter.enqueue(spec(el("p", {}, txt("one")), "#root"));
  m.run();
  assert.equal(painter.lastPatch("#root").kind, "init");
  // A second, changed render produces an el patch (text child changed).
  painter.enqueue(spec(el("p", {}, txt("two")), "#root"));
  m.run();
  assert.equal(painter.lastPatch("#root").kind, "el");
});

test("ref-equal render-spec skips scheduling (enqueue short-circuit)", () => {
  const state = createInitialState();
  const m = mockRaf();
  const painter = createPainter(state, { raf: m.raf, caf: m.caf, isBrowser: false });
  const s = spec(el("div", {}, txt("x")), "#root");
  painter.enqueue(s);
  m.run();
  assert.equal(painter.pending(), false);
  painter.enqueue(s); // same reference (L1 cache hit shape)
  assert.equal(painter.pending(), false, "no frame scheduled for a ref-equal spec");
  assert.equal(m.size(), 0);
});

// ── painter: DOM apply + per-element listener lifecycle ─────────────────────

test("per-element listeners attach on init and detach on replace (no leak)", () => {
  const state = createInitialState();
  const { doc, liveListeners } = makeDoc();
  const root = doc.createElement("root");
  const m = mockRaf();
  const painter = createPainter(state, {
    raf: m.raf, caf: m.caf, isBrowser: true, doc, resolveMount: () => root,
  });

  painter.enqueue(spec(el("div", {}, el("button", { events: { click: { f: '(dispatch "x")' } } }, txt("Hi"))), "#root"));
  m.run();
  assert.equal(liveListeners(), 1, "button listener attached on init");
  assert.equal(root.childNodes.length, 1, "tree mounted into the target");

  // Replace the button with a listener-free span.
  painter.enqueue(spec(el("div", {}, el("span", {}, txt("Bye"))), "#root"));
  m.run();
  assert.equal(liveListeners(), 0, "old listener detached on replace (no leak)");
});

// ── painter: global listener reconciliation per flush ───────────────────────

test("global listeners are reconciled each flush against the resolved target", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [{ name: "user", cels: [
    { key: "open", celType: "ValueCel", metadata: { key: "open", segment: "user" }, v: true },
  ] }], [userManifest]);
  await precomputeOptional(state);

  const doc = fakeTarget();
  const m = mockRaf();
  const painter = createPainter(state, {
    raf: m.raf, caf: m.caf, isBrowser: false,
    resolveTarget: (n) => (n === "document" ? doc : null),
  });

  painter.enqueue(spec(el("div"), "#root", ['document|keydown|(set "open" false)']));
  m.run();
  assert.equal(doc.liveCount(), 1, "global listener attached on flush");

  painter.enqueue(spec(el("div"), "#root", []));
  m.run();
  assert.equal(doc.liveCount(), 0, "global listener removed when its spec drops out");
});

// ── channel wiring: a view cel's fire reaches the painter via drain ─────────

test("plastron-dom.paint ChannelCel forwards fired render-specs to the painter", async () => {
  const state = createInitialState();
  const m = mockRaf();
  setPainter(state, createPainter(state, { raf: m.raf, caf: m.caf, isBrowser: false }));

  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [{ name: "user", cels: [
    { key: "msg", celType: "ValueCel", metadata: { key: "msg", segment: "user" }, v: "hi" },
    {
      key: "view", celType: "FormulaCel",
      metadata: { key: "view", segment: "user", parser: "html-template", schema: "render-spec", channel: ["plastron-dom.paint"], inputMap: { msg: "msg" } },
      f: "<div>{{msg}}</div>",
    },
  ] }], [userManifest]);
  await precomputeOptional(state);

  const runCycle = resolveFn(state, "runCycle");
  const drain = resolveFn(state, "drain");
  await runCycle(state);          // view fires → enqueued on the paint channel
  await drain(state, "plastron-dom.paint"); // → paintDrain → painter.enqueue

  const painter = getPainter(state);
  assert.equal(painter.pending(), true, "painter scheduled a frame from the forwarded render-spec");
  m.run();
  assert.equal(painter.lastPatch(null).kind, "init", "painter diffed + recorded the patch");
});
