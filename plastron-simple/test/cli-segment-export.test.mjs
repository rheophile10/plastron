import { test, beforeAll, beforeEach, afterAll } from "bun:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";

process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs";

const { createInitialState, resolveFn } = await import("../dist/index.js");

let state;
let activeRoot;
const EXPORT_DIR = path.resolve(`./.plastron-export-test-${process.pid}`);

const wipeStore = async () => {
  if (activeRoot !== undefined) {
    await fs.rm(path.resolve(activeRoot, "plastron"), { recursive: true, force: true });
  }
  await fs.rm(EXPORT_DIR, { recursive: true, force: true });
};

beforeAll(async () => {
  state = createInitialState();
  activeRoot = state.cels.get("file-store.root").v;
  await wipeStore();
});
beforeEach(wipeStore);
afterAll(wipeStore);

const call = (key, ...args) => resolveFn(state, key)(...args);
const exportToDir = (dir, opts) => resolveFn(state, "exportToDir")(state, dir, opts);
const importFromDir = (dir, opts) => resolveFn(state, "importFromDir")(state, dir, opts);
const seed = () => resolveFn(state, "seedStore")(state);

const lib = (name, version, deps = []) => ({
  name, version, description: `${name}`, dependencies: deps, role: "library",
});
const seg = (name) => ({
  name, cels: [{ key: `${name}.v`, celType: "ValueCel", metadata: { key: `${name}.v`, segment: name, v: 1 } }],
});

const fileExists = (p) => fs.access(p).then(() => true, () => false);

test("export/import cels resolve under the node-fs backend", () => {
  assert.equal(state.cels.get("file-store.backend").v, "node-fs");
  assert.equal(typeof resolveFn(state, "exportToDir"), "function");
  assert.equal(typeof resolveFn(state, "importFromDir"), "function");
});

test("exportToDir mirrors a stored segment's layout to the target dir", async () => {
  await call("store.put", "chart-helpers", "2.0.1", lib("chart-helpers", "2.0.1"), seg("chart-helpers"));
  const r = await exportToDir(EXPORT_DIR);
  assert.deepEqual(r.exportedSegments, ["chart-helpers"]);
  const base = path.join(EXPORT_DIR, "plastron", "segments", "chart-helpers", "2.0.1");
  assert.equal(await fileExists(path.join(base, "manifest.json")), true);
  assert.equal(await fileExists(path.join(base, "segment.json")), true);
  const idx = JSON.parse(await fs.readFile(path.join(EXPORT_DIR, "plastron", "index.json"), "utf8"));
  assert.equal(idx.segments["chart-helpers"].latest, "2.0.1");
});

test("default export excludes the kernel closure", async () => {
  await seed(); // store now holds the kernel closure
  await call("store.put", "chart-helpers", "2.0.1", lib("chart-helpers", "2.0.1"), seg("chart-helpers"));
  const r = await exportToDir(EXPORT_DIR);
  assert.ok(r.exportedSegments.includes("chart-helpers"));
  assert.ok(!r.exportedSegments.includes("kernel"), "kernel excluded by default");
  assert.ok(!r.exportedSegments.includes("segment-store"), "kernel-closure library excluded by default");
});

test("includeKernel:true exports the kernel closure too", async () => {
  await seed();
  const r = await exportToDir(EXPORT_DIR, { includeKernel: true });
  assert.ok(r.exportedSegments.includes("kernel"));
  assert.ok(r.exportedSegments.includes("file-store"));
});

test("onlySegments pulls in transitive deps by default", async () => {
  await call("store.put", "B", "1.0.0", lib("B", "1.0.0"), seg("B"));
  await call("store.put", "A", "1.0.0", lib("A", "1.0.0", ["B"]), seg("A"));
  const r = await exportToDir(EXPORT_DIR, { onlySegments: ["A"] });
  assert.deepEqual(new Set(r.exportedSegments), new Set(["A", "B"]));
});

test("onlySegments with includeTransitiveDeps:false ships just the named segment", async () => {
  await call("store.put", "B", "1.0.0", lib("B", "1.0.0"), seg("B"));
  await call("store.put", "A", "1.0.0", lib("A", "1.0.0", ["B"]), seg("A"));
  const r = await exportToDir(EXPORT_DIR, { onlySegments: ["A"], includeTransitiveDeps: false });
  assert.deepEqual(r.exportedSegments, ["A"]);
});

test("export → delete-from-store → import round-trips the segment", async () => {
  const manifest = lib("recipe-23", "0.2.0");
  const segment = seg("recipe-23");
  await call("store.put", "recipe-23", "0.2.0", manifest, segment);
  await exportToDir(EXPORT_DIR);
  await call("store.delete", "recipe-23");
  assert.equal(await call("store.has", "recipe-23"), false);

  const r = await importFromDir(EXPORT_DIR);
  assert.deepEqual(r.importedSegments, ["recipe-23"]);
  const got = await call("store.get", "recipe-23");
  assert.deepEqual(got.manifest, manifest);
  assert.deepEqual(got.segment, segment);
});

test("importFromDir refuses role:kernel pairs (kernel comes from the local bundle)", async () => {
  await seed();
  await exportToDir(EXPORT_DIR, { includeKernel: true }); // dir now contains kernel
  await wipeStoreOnly();
  const r = await importFromDir(EXPORT_DIR);
  assert.ok(!r.importedSegments.includes("kernel"), "kernel not imported");
  assert.equal(await call("store.has", "kernel"), false);
});

async function wipeStoreOnly() {
  await fs.rm(path.resolve(activeRoot, "plastron"), { recursive: true, force: true });
}

test("importFromDir throws on a name@version collision unless overwrite is set", async () => {
  await call("store.put", "dup", "1.0.0", lib("dup", "1.0.0"), seg("dup"));
  await exportToDir(EXPORT_DIR);
  // 'dup' still in the store → import collides.
  await assert.rejects(() => importFromDir(EXPORT_DIR), /already in the store/);
  // overwrite clears it.
  const r = await importFromDir(EXPORT_DIR, { overwrite: true });
  assert.deepEqual(r.importedSegments, ["dup"]);
});

test("exportToDir refuses a non-empty target without overwrite", async () => {
  await call("store.put", "x", "1.0.0", lib("x", "1.0.0"), seg("x"));
  await exportToDir(EXPORT_DIR);
  await assert.rejects(() => exportToDir(EXPORT_DIR), /already exists/);
  await exportToDir(EXPORT_DIR, { overwrite: true }); // ok
});
