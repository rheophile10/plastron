import { test } from "bun:test";
import assert from "node:assert/strict";

// File picker — unit coverage of the shared Open modal:
//   - file.pick opens the modal scoped to the current app
//   - picker.cwd starts at /<app> so users land in their app's folder
//   - picker.cd / picker.up move within the modal
//   - picker.select calls file.open + closes the modal
//   - picker.cancel closes without loading
//   - app-scoping: a doc whose manifest.applications doesn't include the
//     picker's app doesn't show up in the body's HTML

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

const tick = () => new Promise((r) => setTimeout(r, 10));

test("file picker — open → navigate → select → close", async () => {
  // The harness uses #app for the app view and #modal for the picker.
  const appRoot = mkEl("app");
  const modalRoot = mkEl("div");
  globalThis.document = {
    createElement: mkEl,
    createTextNode: (s) => ({ nodeType: 3, data: s }),
    querySelector: (s) => (s === "#app" ? appRoot : s === "#modal" ? modalRoot : null),
  };

  const { bootOS } = await import("./browser-main.ts");
  const { state } = await bootOS();
  const { resolveFn, getPainter } = await import("../../plastron-simple/dist/index.js");
  const painter = getPainter(state);
  const r = (k) => resolveFn(state, k);
  const get = (k) => r("get")(state, k);

  const tag = `pk${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const docA = `pick-A-${tag}.txt`, docB = `pick-B-${tag}.txt`;

  // Create two notepad docs the picker can later show.
  await r("os.switch")(state, "notepad");
  await tick(); painter.drain();
  await r("file.new")(state, docA);
  await r("set")(state, "notepad.text", "A content");
  await r("file.save")(state);
  await r("file.new")(state, docB);
  await r("set")(state, "notepad.text", "B content");
  await r("file.save")(state);

  // Picker closed by default.
  assert.equal(get("picker.app"), null, "picker starts closed");

  // Open the picker from Notepad's toolbar.
  await r("file.pick")(state);
  await tick(); painter.drain();
  assert.equal(get("picker.app"), "notepad", "picker scoped to notepad");
  assert.equal(get("picker.cwd"), "/notepad", "cwd lands on /<app>");

  // The modal's view-cel value (a render-spec) is the source of truth for
  // what we'd see in the DOM. Check the cards include both docs.
  const spec = state.cels.get("picker.view")?.v;
  const html = JSON.stringify(spec);
  assert.ok(html.includes(docA), `${docA} in modal`);
  assert.ok(html.includes(docB), `${docB} in modal`);

  // Cancel — picker closes; we're still in notepad with whatever doc was open.
  await r("picker.cancel")(state);
  assert.equal(get("picker.app"), null, "cancel closed the picker");

  // Re-open + navigate up + back down (just checking the cwd plumbing).
  await r("file.pick")(state);
  await r("picker.up")(state);
  assert.equal(get("picker.cwd"), "/", "picker.up went to root");
  await r("picker.cd")(state, "/notepad");
  assert.equal(get("picker.cwd"), "/notepad", "picker.cd went back to /notepad");

  // Select docA → file.open loads it, modal closes, notepad.text restored.
  await r("picker.select")(state, docA);
  await tick(); painter.drain();
  assert.equal(get("picker.app"), null, "select closed the picker");
  assert.equal(get("os.doc"), docA, "os.doc=docA after select");
  assert.equal(get("notepad.text"), "A content", "notepad loaded A's content");
});

test("file picker — app-scoping: notepad's picker excludes sheet files", async () => {
  const appRoot = mkEl("app");
  const modalRoot = mkEl("div");
  globalThis.document = {
    createElement: mkEl,
    createTextNode: (s) => ({ nodeType: 3, data: s }),
    querySelector: (s) => (s === "#app" ? appRoot : s === "#modal" ? modalRoot : null),
  };

  const { bootOS } = await import("./browser-main.ts");
  const { state } = await bootOS();
  const { resolveFn } = await import("../../plastron-simple/dist/index.js");
  const r = (k) => resolveFn(state, k);

  const tag = `sc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const sheetDoc = `book-${tag}.csv`;
  const notepadDoc = `notes-${tag}.txt`;

  // One sheet doc + one notepad doc, side by side.
  await r("os.switch")(state, "sheets");
  await r("file.new")(state, sheetDoc);
  await r("file.save")(state);
  await r("os.exit")(state);

  await r("os.switch")(state, "notepad");
  await r("file.new")(state, notepadDoc);
  await r("file.save")(state);

  // Open notepad's picker. /notepad shows notepadDoc but NOT sheetDoc.
  await r("file.pick")(state);
  await r("picker.cd")(state, "/notepad");
  let html = JSON.stringify(state.cels.get("picker.view")?.v);
  assert.ok(html.includes(notepadDoc), `notepad picker shows ${notepadDoc}`);
  assert.ok(!html.includes(sheetDoc), `notepad picker EXCLUDES ${sheetDoc}`);
  await r("picker.cancel")(state);

  // Switch to sheets, open ITS picker. /sheets shows sheetDoc but not notepadDoc.
  await r("os.exit")(state);
  await r("os.switch")(state, "sheets");
  await r("file.pick")(state);
  await r("picker.cd")(state, "/sheets");
  html = JSON.stringify(state.cels.get("picker.view")?.v);
  assert.ok(html.includes(sheetDoc), `sheets picker shows ${sheetDoc}`);
  assert.ok(!html.includes(notepadDoc), `sheets picker EXCLUDES ${notepadDoc}`);
});
