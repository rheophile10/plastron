import { test } from "bun:test";
import assert from "node:assert/strict";

// Integration smoke: boot the real OS entry (browser-main) against a fake DOM
// and drive the whole wired shell — home screen → launch Sheets → exit home.

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
const tick = () => new Promise((r) => setTimeout(r, 10));

test("the packaged OS boots to a home screen, launches Sheets, and exits home", async () => {
  const root = mkEl("app");
  globalThis.document = { createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }), querySelector: (s) => (s === "#app" ? root : null) };

  // Booting the real entry runs setup + the initial synchronous paint.
  const { bootOS } = await import("./browser-main.ts");
  const { state } = await bootOS();
  const { resolveFn, getPainter } = await import("../../plastron-simple/dist/index.js");
  const painter = getPainter(state);

  // Home screen with all four icons.
  for (const app of ["Sheets", "Notepad", "Files", "Doom"]) assert.ok(button(root, app), `${app} icon present`);

  // Launch Sheets → the spreadsheet view paints (the seeded header is visible)
  // and the shared file toolbar's New/Save/Open buttons are part of the chrome.
  button(root, "Sheets").fire("click");
  await tick(); painter.drain();
  assert.equal(resolveFn(state, "get")(state, "os.active"), "sheets");
  assert.match(txt(root), /Item/, "Sheets grid rendered (seeded A1)");
  assert.match(txt(root), /Total/);
  for (const t of ["New", "Save", "Open"]) assert.ok(button(root, t), `shared file toolbar shows ${t} in Sheets`);

  // Exit → home → launch Notepad → same shared toolbar is present.
  button(root, "×").fire("click");
  await tick(); painter.drain();
  button(root, "Notepad").fire("click");
  await tick(); painter.drain();
  assert.equal(resolveFn(state, "get")(state, "os.active"), "notepad");
  for (const t of ["New", "Save", "Open"]) assert.ok(button(root, t), `shared file toolbar shows ${t} in Notepad`);

  // Exit → launch Files → File Explorer view paints.
  button(root, "×").fire("click");
  await tick(); painter.drain();
  button(root, "Files").fire("click");
  await tick(); painter.drain();
  assert.equal(resolveFn(state, "get")(state, "os.active"), "file-explorer");
  assert.match(txt(root), /File Explorer|Files|user-space|No user-spaces/, "file-explorer renders its chrome");

  // Final exit → back to the launcher.
  button(root, "×").fire("click");
  await tick(); painter.drain();
  assert.equal(resolveFn(state, "get")(state, "os.active"), "home");
  assert.ok(button(root, "Notepad"), "icons back after exit");
});

test("Notepad doc round-trip — New A → type → Save → New B → type → Save → Open A → edit → Save → Open B (unchanged)", async () => {
  const root = mkEl("app");
  globalThis.document = { createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }), querySelector: (s) => (s === "#app" ? root : null) };

  const { bootOS } = await import("./browser-main.ts");
  const { state } = await bootOS();
  const { resolveFn, getPainter } = await import("../../plastron-simple/dist/index.js");
  const painter = getPainter(state);
  const r = (k) => resolveFn(state, k);
  const get = (k) => r("get")(state, k);
  // Unique suffixes so successive runs against the same node-fs root don't collide.
  const tag = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const docA = `notepad-A-${tag}`, docB = `notepad-B-${tag}`;
  const pad = () => walk(root, (n) => n.tag === "textarea")[0];
  const typeInto = async (text) => { const p = pad(); p.value = text; p.fire("input"); await tick(); painter.drain(); };

  // Launch Notepad.
  button(root, "Notepad").fire("click");
  await tick(); painter.drain();
  assert.equal(get("os.active"), "notepad");

  // New A → type → Save.
  await r("file.new")(state, docA);
  await tick(); painter.drain();
  assert.equal(get("os.doc"), docA);
  assert.equal(get("notepad.text"), "", "fresh doc starts empty");
  assert.equal(state.cels.get("notepad.text").metadata.segment, docA, "rebind retargeted segment");
  await typeInto("first thoughts");
  assert.equal(get("notepad.text"), "first thoughts");
  await r("file.save")(state);

  // New B → type → Save.
  await r("file.new")(state, docB);
  await tick(); painter.drain();
  assert.equal(get("os.doc"), docB);
  assert.equal(get("notepad.text"), "", "New cleared the editor");
  await typeInto("second draft");
  await r("file.save")(state);

  // Open A → see "first thoughts" restored.
  await r("file.open")(state, docA);
  await tick(); painter.drain();
  assert.equal(get("os.doc"), docA);
  assert.equal(get("notepad.text"), "first thoughts", "A restored from store");

  // Edit A → Save.
  await typeInto("first thoughts, revised");
  await r("file.save")(state);

  // Open B → still "second draft" (A's edit didn't leak).
  await r("file.open")(state, docB);
  await tick(); painter.drain();
  assert.equal(get("notepad.text"), "second draft", "B untouched");

  // Open A again → see the revision.
  await r("file.open")(state, docA);
  await tick(); painter.drain();
  assert.equal(get("notepad.text"), "first thoughts, revised", "A's edit persisted");

  // Exit → home.
  button(root, "×").fire("click");
  await tick(); painter.drain();
  assert.equal(get("os.active"), "home");
});

test("File Explorer lists user-spaces created by Notepad and opens them", async () => {
  const root = mkEl("app");
  globalThis.document = { createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }), querySelector: (s) => (s === "#app" ? root : null) };

  const { bootOS } = await import("./browser-main.ts");
  const { state } = await bootOS();
  const { resolveFn, getPainter } = await import("../../plastron-simple/dist/index.js");
  const painter = getPainter(state);
  const r = (k) => resolveFn(state, k);
  const get = (k) => r("get")(state, k);
  const tag = `fe${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const docA = `fe-A-${tag}`;

  // Launch Notepad → New → type → Save.
  button(root, "Notepad").fire("click");
  await tick(); painter.drain();
  await r("file.new")(state, docA);
  const pad = walk(root, (n) => n.tag === "textarea")[0];
  pad.value = "hello from fe-A"; pad.fire("input");
  await tick(); painter.drain();
  await r("file.save")(state);

  // Exit → File Explorer → refresh → the doc is listed.
  button(root, "×").fire("click");
  await tick(); painter.drain();
  button(root, "Files").fire("click");
  await tick(); painter.drain();
  await r("fe.refresh")(state);
  await tick(); painter.drain();
  const items = get("file-explorer.items") ?? [];
  assert.ok(items.some((e) => e.name === docA), `${docA} listed in file-explorer.items: ${JSON.stringify(items.map((e)=>e.name))}`);

  // fe.open dispatches loadUserSpace + os.launch back into notepad.
  await r("fe.open")(state, docA);
  await tick(); painter.drain();
  assert.equal(get("os.doc"), docA);
  assert.equal(get("os.active"), "notepad");
  assert.equal(get("notepad.text"), "hello from fe-A");
});

test("Sheets doc round-trip — New A → edits → Save → New B → edits → Open A restored", async () => {
  const root = mkEl("app");
  globalThis.document = { createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }), querySelector: (s) => (s === "#app" ? root : null) };

  const { bootOS } = await import("./browser-main.ts");
  const { state } = await bootOS();
  const { resolveFn, getPainter } = await import("../../plastron-simple/dist/index.js");
  const painter = getPainter(state);
  const r = (k) => resolveFn(state, k);
  const get = (k) => r("get")(state, k);
  const tag = `sh${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const docA = `sheets-A-${tag}`, docB = `sheets-B-${tag}`;

  button(root, "Sheets").fire("click");
  await tick(); painter.drain();

  // New A → set some cells (use setCel directly since the click-into-bar-out
  // flow is exercised in sheets.test.ts) → Save.
  await r("file.new")(state, docA);
  await r("set")(state, "sheet.A1", "doc-A-A1");
  await r("set")(state, "sheet.B2", "42");
  await tick(); painter.drain();
  await r("file.save")(state);

  // New B → different cells → Save.
  await r("file.new")(state, docB);
  assert.equal(get("sheet.A1"), "", "New cleared the grid");
  await r("set")(state, "sheet.A1", "doc-B-A1");
  await r("file.save")(state);

  // Open A → original cells restored.
  await r("file.open")(state, docA);
  assert.equal(get("sheet.A1"), "doc-A-A1");
  assert.equal(get("sheet.B2"), "42");
});
