import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createInitialState, precomputeOptional, resolveFn, createPainter, setPainter,
} from "../../plastron-simple/dist/index.js";
import { setupDesktop } from "./desktop.ts";

// plastron-OS desktop — fake-DOM smoke of the launcher shell: boot to a home
// screen of icons, click one to launch its app, exit back home. Composes
// app-host + html-template + plastron-dom; no Chrome.

// ── compact fake DOM (same shape as the pictograph/css smokes) ──────────────
const mkEl = (tag) => {
  const L = new Map();
  const el = {
    nodeType: 1, tag, tagName: tag.toUpperCase(), value: undefined, childNodes: [], attrs: {}, _L: L,
    style: { props: {}, setProperty(p, v) { this.props[p] = v; }, removeProperty(p) { delete this.props[p]; } },
    get firstChild() { return this.childNodes[0] ?? null; },
    get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; },
    setAttribute(n, v) { this.attrs[n] = v; }, removeAttribute(n) { delete this.attrs[n]; },
    appendChild(c) { this.childNodes.push(c); return c; },
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); return c; },
    replaceChild(n, o) { const i = this.childNodes.indexOf(o); if (i >= 0) this.childNodes[i] = n; return o; },
    insertBefore(n, r) { const i = r ? this.childNodes.indexOf(r) : -1; if (i >= 0) this.childNodes.splice(i, 0, n); else this.childNodes.push(n); return n; },
    replaceChildren(...c) { this.childNodes = [...c]; },
    addEventListener(t, fn) { (L.get(t) ?? L.set(t, new Set()).get(t)).add(fn); },
    removeEventListener(t, fn) { L.get(t)?.delete(fn); },
    fire(t, ev = {}) { for (const fn of [...(L.get(t) ?? [])]) fn({ type: t, target: el, ...ev }); },
  };
  return el;
};
const txt = (n) => (n.nodeType === 3 ? n.data : (n.childNodes ?? []).map(txt).join(""));
const walk = (n, p, o = []) => { if (n?.nodeType === 1) { if (p(n)) o.push(n); for (const c of n.childNodes) walk(c, p, o); } return o; };
const button = (root, contains) => walk(root, (n) => n.tag === "button" && txt(n).includes(contains))[0];
const mockRaf = () => { const q = []; return { raf: (cb) => q.push(cb), caf: () => {}, run: () => { for (const cb of q.splice(0)) cb(); } }; };
const tick = () => new Promise((r) => setTimeout(r, 10));

const APPS = [
  { id: "alpha", title: "Alpha", icon: "🅰", html: `<div class="app"><button class="back" onClick={{(dispatch "os.exit")}}>⌂ Home</button><h2>Alpha App</h2></div>` },
  { id: "beta", title: "Beta", icon: "🅱", html: `<div class="app"><button class="back" onClick={{(dispatch "os.exit")}}>⌂ Home</button><h2>Beta App</h2></div>` },
];

test("desktop boots to a home screen, launches an app on click, and exits home", async () => {
  const root = mkEl("app");
  globalThis.document = { createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }), querySelector: (s) => (s === "#app" ? root : null) };

  const m = mockRaf();
  const state = createInitialState();
  const painter = createPainter(state, { raf: m.raf, caf: m.caf, isBrowser: true, doc: globalThis.document, resolveMount: (x) => (x === "#app" ? root : null) });
  setPainter(state, painter);

  await setupDesktop(state, APPS);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  await resolveFn(state, "drain")(state, "plastron-dom.paint");
  m.run();

  // Home screen: title + an icon per app.
  assert.match(txt(root), /plastron OS/);
  assert.ok(button(root, "Alpha"), "Alpha icon present");
  assert.ok(button(root, "Beta"), "Beta icon present");
  assert.ok(!txt(root).includes("Alpha App"), "no app content while home");

  // Click the Alpha icon → os.switch → repaint shows the Alpha app.
  button(root, "Alpha").fire("click");
  await tick(); m.run();
  assert.equal(resolveFn(state, "get")(state, "os.active"), "alpha");
  assert.match(txt(root), /Alpha App/);
  assert.ok(!txt(root).includes("plastron OS"), "home grid replaced by the app");

  // Click the app's ⌂ Home (os.exit) → back to the launcher.
  button(root, "Home").fire("click");
  await tick(); m.run();
  assert.equal(resolveFn(state, "get")(state, "os.active"), "home");
  assert.match(txt(root), /plastron OS/);
  assert.ok(button(root, "Beta"), "icons back");
});
