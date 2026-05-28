import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createInitialState, precomputeOptional, resolveFn, createPainter, setPainter,
} from "../../plastron-simple/dist/index.js";
import { buildSheetsApp } from "./sheets.ts";

// Sheets — fake-DOM smoke: render the grid as a <table>, select a cell into
// the formula bar, edit + commit, and see the formula recompute in the DOM.

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
const cell = (root, addr) => walk(root, (n) => n.tag === "td" && n.attrs["data-addr"] === addr)[0];
const fx = (root) => walk(root, (n) => n.tag === "input")[0];
const mockRaf = () => { const q = []; return { raf: (cb) => q.push(cb), caf: () => {}, run: () => { for (const cb of q.splice(0)) cb(); } }; };
const tick = () => new Promise((r) => setTimeout(r, 10));

test("Sheets renders the grid, selects into the formula bar, commits a formula", async () => {
  const root = mkEl("app");
  globalThis.document = { createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }), querySelector: (s) => (s === "#app" ? root : null) };

  const m = mockRaf();
  const state = createInitialState();
  setPainter(state, createPainter(state, { raf: m.raf, caf: m.caf, isBrowser: true, doc: globalThis.document, resolveMount: (x) => (x === "#app" ? root : null) }));

  await buildSheetsApp(state, { rows: 3, cols: 3, cells: { A1: "10", B1: "=A1*2" } });
  await precomputeOptional(state);
  await resolveFn(state, "set")(state, "os.active", "sheets"); // gate the sheet view onto #app
  await resolveFn(state, "runCycle")(state);
  await resolveFn(state, "drain")(state, "plastron-dom.paint");
  m.run();

  // Grid rendered: A1 = 10, B1 = =A1*2 = 20.
  assert.equal(txt(cell(root, "A1")), "10");
  assert.equal(txt(cell(root, "B1")), "20", "infix formula computed in the grid");

  // Click B1 → selection + formula bar shows its source.
  cell(root, "B1").fire("click");
  await tick(); m.run();
  assert.equal(resolveFn(state, "get")(state, "sheet.selection").col, 1);
  assert.match(txt(root), /B1/, "formula bar reference updated");
  assert.equal(fx(root).value, "=A1*2", "formula bar loaded the cell's source");

  // Edit the bar to =A1+5 and commit → B1 recomputes to 15.
  const input = fx(root);
  input.value = "=A1+5";
  input.fire("input");
  await tick();
  walk(root, (n) => n.tag === "button" && txt(n) === "✓")[0].fire("click");
  await tick(); m.run();
  assert.equal(txt(cell(root, "B1")), "15", "committed formula recomputed (10 + 5)");
});

test("Pictograph emoji sequence — define a person, create two, wave at each other", async () => {
  const root = mkEl("app");
  globalThis.document = { createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }), querySelector: (s) => (s === "#app" ? root : null) };

  const m = mockRaf();
  const state = createInitialState();
  setPainter(state, createPainter(state, { raf: m.raf, caf: m.caf, isBrowser: true, doc: globalThis.document, resolveMount: (x) => (x === "#app" ? root : null) }));

  // A1 / A2 are the people; B1 / B2 apply the "person template" via & concat
  // (the infix analogue of pictograph's lambda); B3 waves them at each other.
  await buildSheetsApp(state, {
    rows: 4, cols: 3,
    cells: {
      A1: "boy",
      A2: "girl",
      B1: '="Hi, I\'m " & A1',
      B2: '="Hi, I\'m " & A2',
      B3: '=B1 & " 👋 " & B2',
    },
  });
  await precomputeOptional(state);
  await resolveFn(state, "set")(state, "os.active", "sheets");
  await resolveFn(state, "runCycle")(state);
  await resolveFn(state, "drain")(state, "plastron-dom.paint");
  m.run();

  // The formulas compute through the cascade.
  assert.equal(state.cels.get("sheet.B1").v, "Hi, I'm boy");
  assert.equal(state.cels.get("sheet.B2").v, "Hi, I'm girl");
  assert.equal(state.cels.get("sheet.B3").v, "Hi, I'm boy 👋 Hi, I'm girl");

  // The per-cell view renders the wave — including the 👋 emoji — in B3.
  assert.match(txt(cell(root, "B3")), /👋/);
  assert.match(txt(cell(root, "B3")), /boy/);
  assert.match(txt(cell(root, "B3")), /girl/);
});
