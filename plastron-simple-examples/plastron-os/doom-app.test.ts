import { test, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";

// Wipe any leftover OPFS-seeded doom assets between runs so the loadDoomAsset
// cache-hit branch isn't poisoned by a previous test (node-fs backend persists
// at .plastron-fs/doom/*).
beforeEach(async () => {
  await rm(".plastron-fs/doom", { recursive: true, force: true });
});

// Smoke: setupDoom (browser-main's replacement for setupDoomStub) hydrates
// the doom segment, registers the doom.boot action, and the view contains
// the canvas the harness will paint into. We don't actually run the engine
// here — fetch + a real canvas aren't available — but we do trigger boot
// and assert the status surfaces a recoverable error, proving the boot path
// is reachable and doesn't crash.

const mkEl = (tag) => {
  const L = new Map();
  const el = {
    nodeType: 1, tag, tagName: tag.toUpperCase(),
    value: undefined, childNodes: [], attrs: {}, _L: L, id: "",
    style: { props: {}, setProperty(p, v) { this.props[p] = v; }, removeProperty(p) { delete this.props[p]; } },
    get firstChild() { return this.childNodes[0] ?? null; },
    get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; },
    setAttribute(n, v) { this.attrs[n] = v; if (n === "id") this.id = v; },
    removeAttribute(n) { delete this.attrs[n]; if (n === "id") this.id = ""; },
    appendChild(c) { this.childNodes.push(c); return c; },
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); return c; },
    replaceChild(n, o) { const i = this.childNodes.indexOf(o); if (i >= 0) this.childNodes[i] = n; return o; },
    insertBefore(n, r) { const i = r ? this.childNodes.indexOf(r) : -1; if (i >= 0) this.childNodes.splice(i, 0, n); else this.childNodes.push(n); return n; },
    replaceChildren(...c) { this.childNodes = [...c]; },
    addEventListener(t, fn) { (L.get(t) ?? L.set(t, new Set()).get(t)).add(fn); },
    removeEventListener(t, fn) { L.get(t)?.delete(fn); },
    focus() {},
    fire(t, ev = {}) { for (const fn of [...(L.get(t) ?? [])]) fn({ type: t, target: el, ...ev }); },
  };
  return el;
};
const walk = (n, p, o = []) => { if (n?.nodeType === 1) { if (p(n)) o.push(n); for (const c of n.childNodes) walk(c, p, o); } return o; };
const byId = (root, id) => walk(root, (n) => n.id === id)[0];

test("setupDoom hydrates the doom segment with a #doom-screen canvas + a registered doom.boot", async () => {
  const root = mkEl("app");
  globalThis.document = {
    createElement: mkEl,
    createTextNode: (s) => ({ nodeType: 3, data: s }),
    querySelector: (s) => (s === "#app" ? root : null),
    getElementById: (id) => (id === "app" ? root : byId(root, id)),
  };

  const { bootOS } = await import("./browser-main.ts");
  const { state } = await bootOS();
  const { resolveFn, getPainter } = await import("../../plastron-simple/dist/index.js");

  // The persistent cels the desktop relies on.
  assert.equal(state.segments.get("doom")?.role, "application");
  assert.equal(state.cels.has("doom.mount"), true);
  assert.equal(state.cels.has("doom.status"), true);
  assert.equal(state.cels.has("doom.view"), true);
  // The boot action got registered as a fn.
  assert.equal(typeof resolveFn(state, "doom.boot"), "function");

  // Switch to Doom and re-render — the view must paint a canvas with id
  // "doom-screen" (the element the harness will draw frames into).
  await resolveFn(state, "set")(state, "os.active", "doom");
  await resolveFn(state, "runCycle")(state);
  await resolveFn(state, "drain")(state, "plastron-dom.paint");
  getPainter(state).drain();
  const canvas = byId(root, "doom-screen");
  assert.ok(canvas, "view should render a #doom-screen canvas");
  assert.equal(canvas.tag, "canvas");
});

test("doom.boot reports a recoverable error when the WAD/wasm aren't served (proves the boot path is reachable)", async () => {
  const root = mkEl("app");
  globalThis.document = {
    createElement: mkEl,
    createTextNode: (s) => ({ nodeType: 3, data: s }),
    querySelector: (s) => (s === "#app" ? root : null),
    getElementById: (id) => (id === "app" ? root : byId(root, id)),
  };

  const { bootOS } = await import("./browser-main.ts");
  const { state } = await bootOS();
  const { resolveFn, getPainter } = await import("../../plastron-simple/dist/index.js");

  await resolveFn(state, "set")(state, "os.active", "doom");
  await resolveFn(state, "runCycle")(state);
  await resolveFn(state, "drain")(state, "plastron-dom.paint");
  getPainter(state).drain();

  // Stub fetch so the test is hermetic. With the new boot flow, doom.boot
  // uses bundle-inlined gz-b64 bytes (when present) or fetch (when absent)
  // and then builds the harness. The mock canvas has no `.getContext`, so
  // the harness build throws — that's still a recoverable error: doom.boot
  // catches it and writes a message to doom.status. The invariant the
  // test cares about is that the boot path was REACHED (the dispatch +
  // canvas lookup + asset load all completed) and the error surfaced via
  // doom.status rather than crashing silently.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 404 });
  try {
    await resolveFn(state, "doom.boot")(state);
  } finally {
    globalThis.fetch = origFetch;
  }
  const status = state.cels.get("doom.status").v;
  assert.match(String(status),
    /doom\.wasm not found|HTTP 404|WAD|boot failed|getContext|no WAD/i,
    `expected a recoverable boot error in doom.status; got: ${status}`);
});
