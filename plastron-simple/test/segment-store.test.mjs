import { test, beforeAll, afterAll, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";

// segment-store composes over file-store, which binds its backend (and
// root) once at module load. Best-effort set a node-fs root before the
// first dist import; tolerate the singleton already being bound by an
// earlier suite in a multi-file `bun test` run.
process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs";

const { createInitialState, resolveFn, precompute, precomputeOptional } = await import("../dist/index.js");

let state;
let activeRoot;

// segment-store writes to a fixed `plastron/` subtree under the file-store
// root (the layout is not per-test-prefixed by design). Isolate by wiping
// that subtree around the suite. No other suite touches `plastron/`.
const wipeStore = async () => {
  if (activeRoot !== undefined) {
    await fs.rm(path.resolve(activeRoot, "plastron"), { recursive: true, force: true });
  }
};

beforeAll(async () => {
  state = createInitialState();
  activeRoot = state.cels.get("file-store.root").v;
  await wipeStore();
});
beforeEach(wipeStore);
afterAll(wipeStore);

const call = (key, ...args) => resolveFn(state, key)(...args);

const manifestOf = (name, version, extra = {}) => ({
  name, version, description: `${name} @ ${version}`,
  dependencies: [], role: "user-space", applications: ["spreadsheet"], ...extra,
});
const segmentOf = (name) => ({
  name,
  cels: [
    { key: `${name}.a`, celType: "ValueCel", metadata: { key: `${name}.a`, segment: name }, v: 1 },
    { key: `${name}.b`, celType: "ValueCel", metadata: { key: `${name}.b`, segment: name }, v: "two" },
  ],
});

// ----- boot wiring -----

test("segment-store boots: the five store.* cels resolve to fns", () => {
  for (const key of ["store.put", "store.get", "store.list", "store.delete", "store.has"]) {
    assert.equal(typeof resolveFn(state, key), "function", `${key} should resolve`);
  }
});

test("segment-store manifest is role:library and depends on file-store", () => {
  const m = state.segments.get("segment-store");
  assert.ok(m, "segment-store manifest present");
  assert.equal(m.role, "library");
  assert.deepEqual(m.dependencies, ["file-store"]);
});

// ----- put / get round-trip -----

test("store.put then store.get returns the manifest + segment unchanged", async () => {
  const manifest = manifestOf("my-budget", "0.1.4");
  const segment = segmentOf("my-budget");
  await call("store.put", "my-budget", "0.1.4", manifest, segment);
  const got = await call("store.get", "my-budget");
  assert.deepEqual(got.manifest, manifest);
  assert.deepEqual(got.segment, segment);
});

test("store.get defaults to the latest version after a version bump", async () => {
  await call("store.put", "my-budget", "0.1.3", manifestOf("my-budget", "0.1.3"), segmentOf("my-budget"));
  await call("store.put", "my-budget", "0.1.4", manifestOf("my-budget", "0.1.4"), segmentOf("my-budget"));
  const got = await call("store.get", "my-budget");
  assert.equal(got.manifest.version, "0.1.4");
});

test("store.get with an explicit older version returns that version", async () => {
  await call("store.put", "my-budget", "0.1.3", manifestOf("my-budget", "0.1.3"), segmentOf("my-budget"));
  await call("store.put", "my-budget", "0.1.4", manifestOf("my-budget", "0.1.4"), segmentOf("my-budget"));
  const got = await call("store.get", "my-budget", "0.1.3");
  assert.equal(got.manifest.version, "0.1.3");
});

// ----- has / list / missing -----

test("store.has is true for a stored name and false otherwise", async () => {
  await call("store.put", "recipe-23", "0.2.0", manifestOf("recipe-23", "0.2.0"), segmentOf("recipe-23"));
  assert.equal(await call("store.has", "recipe-23"), true);
  assert.equal(await call("store.has", "never-stored"), false);
});

test("store.list returns one {name, latest} row per stored segment", async () => {
  await call("store.put", "a", "1.0.0", manifestOf("a", "1.0.0"), segmentOf("a"));
  await call("store.put", "a", "1.1.0", manifestOf("a", "1.1.0"), segmentOf("a"));
  await call("store.put", "b", "2.0.0", manifestOf("b", "2.0.0"), segmentOf("b"));
  const rows = (await call("store.list")).sort((x, y) => x.name.localeCompare(y.name));
  assert.deepEqual(rows, [{ name: "a", latest: "1.1.0" }, { name: "b", latest: "2.0.0" }]);
});

test("store.get of a name with nothing stored returns undefined", async () => {
  assert.equal(await call("store.get", "absent"), undefined);
});

test("store.get of a name's missing version returns undefined", async () => {
  await call("store.put", "x", "1.0.0", manifestOf("x", "1.0.0"), segmentOf("x"));
  assert.equal(await call("store.get", "x", "9.9.9"), undefined);
});

// ----- delete -----

test("store.delete removes a version and repoints latest to the survivor", async () => {
  await call("store.put", "y", "1.0.0", manifestOf("y", "1.0.0"), segmentOf("y"));
  await call("store.put", "y", "1.1.0", manifestOf("y", "1.1.0"), segmentOf("y"));
  await call("store.delete", "y", "1.1.0"); // delete the latest
  assert.equal(await call("store.has", "y"), true);
  const got = await call("store.get", "y");
  assert.equal(got.manifest.version, "1.0.0");
  assert.equal(await call("store.get", "y", "1.1.0"), undefined);
});

test("store.delete of the last version removes the segment entry entirely", async () => {
  await call("store.put", "z", "1.0.0", manifestOf("z", "1.0.0"), segmentOf("z"));
  await call("store.delete", "z", "1.0.0");
  assert.equal(await call("store.has", "z"), false);
  assert.equal(await call("store.get", "z"), undefined);
});

test("store.delete of an absent name is a no-op (does not throw)", async () => {
  await call("store.delete", "nope"); // resolves without error
});

// ----- validation + guards -----

test("store.put rejects a name containing a path separator", async () => {
  await assert.rejects(
    async () => { await call("store.put", "evil/../name", "1.0.0", manifestOf("x", "1.0.0"), segmentOf("x")); },
    /invalid name/,
  );
});

test("store.put rejects a version that starts with a dot", async () => {
  await assert.rejects(
    async () => { await call("store.put", "ok", ".hidden", manifestOf("ok", ".hidden"), segmentOf("ok")); },
    /invalid version/,
  );
});

test("store.put with a missing version throws", async () => {
  await assert.rejects(
    async () => { await call("store.put", "ok", "", manifestOf("ok", ""), segmentOf("ok")); },
    /version must be a non-empty string/,
  );
});

test("store.put refuses a manifest with role:kernel", async () => {
  await assert.rejects(
    async () => { await call("store.put", "kernel", "1.0.0", manifestOf("kernel", "1.0.0", { role: "kernel" }), segmentOf("kernel")); },
    /kernel/,
  );
});

// ----- atomicity -----

// ----- integration: store → hydrate → live state -----

test("a stored segment round-trips through hydrate into a fresh state and computes", async () => {
  // Put a segment carrying value cels + an S-expression formula. (Value
  // lives in metadata.v — the dehydrated shape hydrate reads from.)
  const seg = {
    name: "rt",
    cels: [
      { key: "rt.x", celType: "ValueCel", metadata: { key: "rt.x", segment: "rt", v: 6 } },
      { key: "rt.y", celType: "ValueCel", metadata: { key: "rt.y", segment: "rt", v: 7 } },
      { key: "rt.sum", celType: "FormulaCel", metadata: { key: "rt.sum", segment: "rt", parser: "f" }, f: "(+ rt.x rt.y)" },
    ],
  };
  const manifest = {
    name: "rt", version: "1.0.0", description: "store→hydrate round-trip",
    dependencies: ["builtins"], role: "library",
  };
  await call("store.put", "rt", "1.0.0", manifest, seg);
  const got = await call("store.get", "rt");

  // Hydrate the fetched pair into a brand-new state and run a cycle.
  const fresh = createInitialState();
  await resolveFn(fresh, "hydrate")(fresh, [got.segment], [got.manifest]);
  precompute(fresh);
  await precomputeOptional(fresh);
  await resolveFn(fresh, "runCycle")(fresh);

  assert.equal(fresh.cels.get("rt.x").v, 6);
  assert.equal(fresh.cels.get("rt.sum").v, 13, "(+ rt.x rt.y) should compute after hydrate-from-store");
});

test("after a put the index.json.tmp does not linger and index.json is valid JSON", async () => {
  await call("store.put", "atomic", "1.0.0", manifestOf("atomic", "1.0.0"), segmentOf("atomic"));
  const tmp = path.resolve(activeRoot, "plastron", "index.json.tmp");
  const idxPath = path.resolve(activeRoot, "plastron", "index.json");
  assert.equal(await fs.access(tmp).then(() => true, () => false), false, "tmp should be renamed away");
  const idx = JSON.parse(await fs.readFile(idxPath, "utf-8"));
  assert.equal(idx.version, 1);
  assert.ok(idx.segments.atomic, "index records the put");
  assert.equal(idx.segments.atomic.latest, "1.0.0");
});
