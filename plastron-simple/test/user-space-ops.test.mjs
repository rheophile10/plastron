import { test, beforeAll, beforeEach, afterAll } from "bun:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";

process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs-uso";

const { createInitialState, resolveFn } = await import("../dist/index.js");

let activeRoot;

const wipeStore = async () => {
  if (activeRoot !== undefined) {
    await fs.rm(path.resolve(activeRoot, "plastron"), { recursive: true, force: true });
  }
};

beforeAll(async () => {
  activeRoot = createInitialState().cels.get("file-store.root").v;
  await wipeStore();
});
beforeEach(wipeStore);
afterAll(wipeStore);

const fn = (state, key) => resolveFn(state, key);

// Boot a state, load a role:"application" segment, and seed the store so
// cross-state loads (auto-start) can read everything back.
const bootWithApp = async (appName = "demo-app", appDeps = []) => {
  const state = createInitialState();
  await fn(state, "hydrate")(
    state,
    [{ name: appName, cels: [] }],
    [{ name: appName, version: "1.0.0", description: "test app", role: "application", dependencies: appDeps }],
  );
  await fn(state, "seedStore")(state);
  return state;
};

const valueCel = (segment, key, v) => ({
  key, celType: "ValueCel", metadata: { key, segment, v },
});

// ── boot ────────────────────────────────────────────────────────────────────

test("user-space-ops seeds its five lifecycle cels", () => {
  const state = createInitialState();
  for (const key of ["newUserSpace", "saveUserSpace", "loadUserSpace", "closeUserSpace", "hydrate-closure"]) {
    assert.equal(typeof resolveFn(state, key), "function", `${key} should resolve to a fn`);
  }
});

test("user-space-ops is in the kernel closure — flush refuses it", async () => {
  const state = createInitialState();
  await assert.rejects(() => fn(state, "flush")(state, "user-space-ops"), /kernel closure/i);
});

// ── newUserSpace ──────────────────────────────────────────────────────────

test("newUserSpace throws when the application isn't a loaded role:application segment", async () => {
  const state = createInitialState();
  await assert.rejects(
    () => fn(state, "newUserSpace")(state, "doc", "no-such-app"),
    /not a loaded role:"application"/,
  );
});

test("newUserSpace creates the user-space, auto-saves it, and returns its manifest", async () => {
  const state = await bootWithApp();
  const manifest = await fn(state, "newUserSpace")(state, "doc", "demo-app");

  assert.equal(manifest.role, "user-space");
  assert.deepEqual(manifest.applications, ["demo-app"]);
  assert.deepEqual(manifest.dependencies, ["demo-app"]);
  // loaded into state...
  assert.ok(state.segments.has("doc"));
  // ...and persisted to the store (autoSave default true).
  assert.equal(await fn(state, "store.has")("doc"), true);
});

test("newUserSpace collides on an existing stored name; overwrite:true bypasses", async () => {
  const state = await bootWithApp();
  await fn(state, "newUserSpace")(state, "doc", "demo-app");          // saved
  await fn(state, "closeUserSpace")(state, "doc");                     // unload, leave on disk

  await assert.rejects(
    () => fn(state, "newUserSpace")(state, "doc", "demo-app"),
    /already exists in segment-store/,
  );
  // overwrite opt-in succeeds.
  const m = await fn(state, "newUserSpace")(state, "doc", "demo-app", { overwrite: true });
  assert.equal(m.name, "doc");
});

// ── round-trip contract: new → mutate → save → close → load ────────────────

test("round-trip: saved cels return after close+load; libraries never leave", async () => {
  const state = await bootWithApp();
  // Create without auto-save, add a cel, then save.
  await fn(state, "newUserSpace")(state, "doc", "demo-app", { autoSave: false });
  await fn(state, "hydrate")(
    state,
    [{ name: "doc", cels: [valueCel("doc", "doc.x", 42)] }],
    [{ name: "doc", version: "0.0.1", description: "", role: "user-space", applications: ["demo-app"], dependencies: ["demo-app"] }],
  );
  await fn(state, "saveUserSpace")(state, "doc");

  // Close: the user-space cels go; the app + segment-store stay.
  await fn(state, "closeUserSpace")(state, "doc");
  assert.equal(state.cels.has("doc.x"), false, "user-space cel removed on close");
  assert.equal(state.segments.has("doc"), false, "user-space manifest removed on close");
  assert.ok(state.segments.has("demo-app"), "application stays loaded");
  assert.ok(state.segments.has("segment-store"), "shared library stays loaded");

  // Reload: the cell is back.
  const m = await fn(state, "loadUserSpace")(state, "doc");
  assert.equal(m.name, "doc");
  assert.equal(state.cels.get("doc.x")?.v, 42, "saved cel restored on load");
});

test("reopening an already-loaded user-space is a no-op (hydrate-closure returns [])", async () => {
  const state = await bootWithApp();
  await fn(state, "newUserSpace")(state, "doc", "demo-app");
  // Already loaded → closure filters everything.
  const loaded = await fn(state, "hydrate-closure")(state, "doc");
  assert.deepEqual(loaded, []);
  // loadUserSpace on the open doc still resolves to its manifest.
  const m = await fn(state, "loadUserSpace")(state, "doc");
  assert.equal(m.name, "doc");
});

// ── application auto-start across a fresh state ────────────────────────────

test("loadUserSpace auto-starts the parent application in a fresh state", async () => {
  // State A authors + saves doc (and seeds demo-app into the store).
  const stateA = await bootWithApp();
  await fn(stateA, "newUserSpace")(stateA, "doc", "demo-app");
  await fn(stateA, "saveUserSpace")(stateA, "doc");

  // State B is fresh kernel-only: demo-app is NOT loaded.
  const stateB = createInitialState();
  assert.equal(stateB.segments.has("demo-app"), false);

  const m = await fn(stateB, "loadUserSpace")(stateB, "doc");
  assert.equal(m.name, "doc");
  assert.ok(stateB.segments.has("demo-app"), "application auto-started from the store");
  assert.ok(stateB.segments.has("doc"), "user-space loaded");
});

// ── private-dep closure: save + close cover owned user-space deps ──────────

test("a private user-space dep travels with save and close; shared deps don't", async () => {
  const state = await bootWithApp();
  // A private helper user-space tagged for the same app.
  await fn(state, "hydrate")(
    state,
    [{ name: "doc-notes", cels: [valueCel("doc-notes", "doc-notes.n", 7)] }],
    [{ name: "doc-notes", version: "0.0.1", description: "", role: "user-space", applications: ["demo-app"], dependencies: ["demo-app"] }],
  );
  // doc depends on the private helper.
  await fn(state, "newUserSpace")(state, "doc", "demo-app", { autoSave: false, extraDeps: ["doc-notes"] });
  const persisted = await fn(state, "saveUserSpace")(state, "doc");
  assert.deepEqual(new Set(persisted), new Set(["doc", "doc-notes"]), "private closure = doc + its private dep");
  assert.equal(await fn(state, "store.has")("doc-notes"), true, "private dep persisted");

  // Close flushes both the user-space and its private dep; app stays.
  await fn(state, "closeUserSpace")(state, "doc");
  assert.equal(state.segments.has("doc"), false);
  assert.equal(state.segments.has("doc-notes"), false, "private dep flushed with its owner");
  assert.ok(state.segments.has("demo-app"), "application not evicted");
});

// ── role guards ─────────────────────────────────────────────────────────────

test("save/close/load reject a non-user-space segment", async () => {
  const state = await bootWithApp();
  await assert.rejects(() => fn(state, "saveUserSpace")(state, "demo-app"), /not "user-space"/);
  await assert.rejects(() => fn(state, "closeUserSpace")(state, "demo-app"), /not "user-space"/);
  // loadUserSpace probes the store: demo-app is stored as role:application.
  await assert.rejects(() => fn(state, "loadUserSpace")(state, "demo-app"), /not "user-space"/);
});
