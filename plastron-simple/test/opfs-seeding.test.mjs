import { test, beforeAll, beforeEach, afterAll } from "bun:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";

process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs";

const { createInitialState, resolveFn } = await import("../dist/index.js");

let state;
let activeRoot;

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
const seed = () => resolveFn(state, "seedStore")(state);

test("seedStore boots: the cel resolves to a fn", () => {
  assert.equal(typeof resolveFn(state, "seedStore"), "function");
});

test("first seed writes the kernel closure to the store and creates index.json", async () => {
  const result = await seed();
  // Every boot-loaded segment got seeded on a fresh store.
  assert.equal(result.skipped.length, 0);
  assert.deepEqual(new Set(result.seeded), new Set(state.segments.keys()));
  // index.json exists and records the seeded names.
  const idxPath = path.resolve(activeRoot, "plastron", "index.json");
  const idx = JSON.parse(await fs.readFile(idxPath, "utf8"));
  for (const name of state.segments.keys()) {
    assert.ok(idx.segments[name], `index should record "${name}"`);
  }
});

test("seedStore seeds the role:kernel segment (putRaw bypasses the kernel guard)", async () => {
  await seed();
  // store.put would REFUSE this; seedStore uses putRaw, so it lands.
  assert.equal(await call("store.has", "kernel"), true);
  const got = await call("store.get", "kernel");
  assert.equal(got.manifest.role, "kernel");
});

test("a seeded library segment round-trips through store.get with its cels", async () => {
  await seed();
  const got = await call("store.get", "segment-store");
  assert.equal(got.manifest.name, "segment-store");
  assert.ok(Array.isArray(got.segment.cels) && got.segment.cels.length > 0,
    "seeded segment.json carries the segment's dehydrated cels");
});

test("second seed is idempotent — nothing re-seeded", async () => {
  const first = await seed();
  const second = await seed();
  assert.ok(first.seeded.length > 0, "first boot seeds");
  assert.equal(second.seeded.length, 0, "second boot seeds nothing");
  assert.deepEqual(new Set(second.skipped), new Set(state.segments.keys()));
});

test("two seeds produce an identical stored segment set (store.list stable)", async () => {
  await seed();
  const after1 = (await call("store.list")).map((r) => r.name).sort();
  await seed();
  const after2 = (await call("store.list")).map((r) => r.name).sort();
  assert.deepEqual(after1, after2);
});
