import { test } from "bun:test";
import assert from "node:assert/strict";

// File Explorer v2 — unit coverage of the folders + locations model:
//   - fs-tree user-space gets seeded with one folder per app
//   - refresh auto-files new docs into /<app>
//   - mkdir adds folders under cwd; move retargets a file's location
//   - the dragstart→drop fns thread dataTransfer through to fe.move
//   - the state round-trips: after a "reload" (fresh state + load), the
//     fs-tree segment restores the folder layout

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

test("File Explorer v2 — fs-tree seeded; new docs auto-file under /<app>; mkdir + move persist", async () => {
  const root = mkEl("app");
  globalThis.document = { createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }), querySelector: (s) => (s === "#app" ? root : null) };

  const { bootOS } = await import("./browser-main.ts");
  const { state } = await bootOS();
  const { resolveFn, getPainter } = await import("../../plastron-simple/dist/index.js");
  const painter = getPainter(state);
  const r = (k) => resolveFn(state, k);
  const get = (k) => r("get")(state, k);
  const tag = `fe2${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const docA = `fe2-A-${tag}.txt`, docB = `fe2-B-${tag}.txt`;

  // Boot leaves fs-tree seeded with at least the app folders.
  const seededFolders = get("fs-tree.folders");
  assert.ok(Array.isArray(seededFolders), "fs-tree.folders is an array");
  assert.ok(seededFolders.includes("/notepad"), `seeded folders include /notepad (got ${JSON.stringify(seededFolders)})`);

  // Make a notepad doc → file.new + save → fs-tree.locations should record it.
  await r("os.switch")(state, "notepad");
  await tick(); painter.drain();
  await r("file.new")(state, docA);
  const pad = root.childNodes.length ? null : null; // textarea grabbed by walk further down
  // Type via the cel directly is fine here (the toolbar wiring is covered elsewhere).
  await r("set")(state, "notepad.text", "doc-A content");
  await r("file.save")(state);

  const locs1 = get("fs-tree.locations") ?? {};
  assert.equal(locs1[docA], "/notepad", `${docA} auto-filed to /notepad (got ${JSON.stringify(locs1)})`);

  // mkdir an archive folder + move docA into it.
  await r("file.new")(state, docB);
  await r("set")(state, "notepad.text", "doc-B content");
  await r("file.save")(state);

  await r("os.exit")(state);
  await r("os.switch")(state, "file-explorer");
  await r("fe.refresh")(state);

  const folder = `/archive-${tag}`;
  await r("fe.cd")(state, "/");
  const made = await r("fe.mkdir")(state, `archive-${tag}`);
  assert.equal(made, folder, "mkdir returned the new folder path");
  const folders2 = get("fs-tree.folders");
  assert.ok(folders2.includes(folder), `folders includes ${folder}`);

  await r("fe.move")(state, docA, folder);
  const locs2 = get("fs-tree.locations");
  assert.equal(locs2[docA], folder, `${docA} moved to ${folder}`);
  assert.equal(locs2[docB], "/notepad", `${docB} unmoved`);

  // dragstart + drop simulation: dragstart writes name into dataTransfer,
  // drop reads it and routes to fe.move. The kernel passes the native event
  // as the 3rd arg; we synthesize a minimal shape.
  const evt = {
    preventDefault: () => {},
    dataTransfer: {
      _data: {},
      setData(k, v) { this._data[k] = v; },
      getData(k) { return this._data[k] ?? ""; },
      effectAllowed: "", dropEffect: "",
    },
  };
  r("fe.dragstart")(state, docB, evt);
  assert.equal(evt.dataTransfer._data["text/plain"], docB, "dragstart populated dataTransfer");
  await r("fe.drop")(state, folder, evt);
  assert.equal(get("fs-tree.locations")[docB], folder, `${docB} dropped into ${folder}`);

  // cd into the folder; navigation up returns to root.
  await r("fe.cd")(state, folder);
  assert.equal(get("file-explorer.cwd"), folder, "cwd=folder");
  await r("fe.up")(state);
  assert.equal(get("file-explorer.cwd"), "/", "cwd back to /");

  // Round-trip through the segment-store: drop the in-memory state, boot a
  // fresh OS, see that fs-tree restored the folder + location entries.
  globalThis.document = { createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }), querySelector: (s) => (s === "#app" ? mkEl("app") : null) };
  const { bootOS: bootOS2 } = await import("./browser-main.ts");
  const { state: state2 } = await bootOS2();
  const get2 = (k) => resolveFn(state2, k)(state2, k);
  const folders3 = (resolveFn(state2, "get"))(state2, "fs-tree.folders");
  const locs3 = (resolveFn(state2, "get"))(state2, "fs-tree.locations");
  assert.ok(folders3.includes(folder), `[reload] folders includes ${folder} (got ${JSON.stringify(folders3)})`);
  assert.equal(locs3[docA], folder, `[reload] ${docA} location restored`);
  assert.equal(locs3[docB], folder, `[reload] ${docB} location restored`);
});

test("apps self-register their app-type with file-explorer; /Desktop seeded with README", async () => {
  const root = mkEl("app");
  globalThis.document = {
    createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }),
    querySelector: (s) => (s === "#app" ? root : s === "#modal" ? mkEl("div") : null),
  };

  const { bootOS } = await import("./browser-main.ts");
  const { state } = await bootOS();
  const { resolveFn } = await import("../../plastron-simple/dist/index.js");
  const r = (k) => resolveFn(state, k);
  const get = (k) => r("get")(state, k);

  // fe.app-types populated by each app's setup.
  const types = get("fe.app-types") ?? {};
  for (const expected of ["notepad", "sheets", "doom", "file-explorer"]) {
    assert.ok(types[expected], `app-types includes ${expected} (got ${Object.keys(types).join(", ")})`);
    assert.ok(types[expected].key === expected, `app-type's key matches: ${expected}`);
    assert.ok(typeof types[expected].icon === "string" && types[expected].icon.length > 0, `${expected}.icon set`);
  }
  assert.equal(types.notepad.extension, "txt", "notepad extension is txt");
  assert.equal(types.sheets.extension, "csv", "sheets extension is csv");
  assert.equal(types.doom.extension, "wad", "doom extension is wad");

  // Per-app value cels also expose the type.
  assert.deepEqual(state.cels.get("notepad.app-type")?.v, types.notepad, "notepad.app-type cel matches registry");
  assert.deepEqual(state.cels.get("sheets.app-type")?.v, types.sheets,   "sheets.app-type cel matches registry");
  assert.deepEqual(state.cels.get("doom.app-type")?.v,   types.doom,     "doom.app-type cel matches registry");

  // /Desktop is in the seeded folder list.
  assert.ok((get("fs-tree.folders") ?? []).includes("/Desktop"), "/Desktop is a seeded folder");

  // Default cwd lands on /Desktop so the README is what the user sees first.
  assert.equal(get("file-explorer.cwd"), "/Desktop", "explorer starts at /Desktop");

  // README.txt was created at /Desktop on first boot.
  const locations = get("fs-tree.locations") ?? {};
  assert.equal(locations["README.txt"], "/Desktop", "README is on the Desktop");

  // The README has actual content (use fe.open, which handles load +
  // os.launch — file.open requires the app to already be active).
  await r("fe.open")(state, "README.txt");
  assert.equal(get("os.doc"), "README.txt", "README opened");
  assert.equal(get("os.active"), "notepad", "notepad launched to read it");
  assert.match(get("notepad.text"), /plastron-OS/, "README content includes a plastron-OS heading");
});

test("fileNew appends the app's extension when missing, keeps it when present", async () => {
  const root = mkEl("app");
  globalThis.document = {
    createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }),
    querySelector: (s) => (s === "#app" ? root : s === "#modal" ? mkEl("div") : null),
  };

  const { bootOS } = await import("./browser-main.ts");
  const { state } = await bootOS();
  const { resolveFn } = await import("../../plastron-simple/dist/index.js");
  const r = (k) => resolveFn(state, k);
  const get = (k) => r("get")(state, k);
  const tag = `ext${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

  // 1. Notepad with no extension → .txt appended.
  await r("os.switch")(state, "notepad");
  await r("file.new")(state, `bare-${tag}`);
  assert.equal(get("os.doc"), `bare-${tag}.txt`, "notepad file got .txt");
  await r("os.exit")(state);

  // 2. Notepad with .txt → not double-appended.
  await r("os.switch")(state, "notepad");
  await r("file.new")(state, `pre-${tag}.txt`);
  assert.equal(get("os.doc"), `pre-${tag}.txt`, "existing .txt preserved");
  await r("os.exit")(state);

  // 3. Sheets gets .csv.
  await r("os.switch")(state, "sheets");
  await r("file.new")(state, `sheet-${tag}`);
  assert.equal(get("os.doc"), `sheet-${tag}.csv`, "sheets file got .csv");
});
