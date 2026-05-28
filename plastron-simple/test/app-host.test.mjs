import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// app-host — the plastron-OS launcher mechanism (rendering-agnostic):
// os.active / os.apps / os.doc cels + os.launch / os.switch / os.exit /
// os.register-app, composed over user-space-ops. Headless — no DOM.

const boot = async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  // newUserSpace needs a loaded role:application segment to parent the doc.
  const appSeg = {
    name: "alpha-app", version: "1.0.0", dependencies: [], role: "application",
    cels: [{ key: "alpha.title", celType: "ValueCel", metadata: { key: "alpha.title", segment: "alpha-app" }, v: "Alpha" }],
  };
  await hydrate(state, [appSeg], [{ name: "alpha-app", version: "1.0.0", dependencies: [], role: "application" }]);
  return state;
};
const get = (state, k) => state.cels.get(k)?.v;
const op = (state, k) => resolveFn(state, k);

test("app-host seeds os.active / os.apps / os.doc at boot", async () => {
  const state = await boot();
  assert.equal(get(state, "os.active"), "home");
  assert.deepEqual(get(state, "os.apps"), []);
  assert.equal(get(state, "os.doc"), null);
});

test("os.register-app appends to the registry, idempotent by id", async () => {
  const state = await boot();
  await op(state, "os.register-app")(state, { id: "alpha", title: "Alpha", icon: "🅰", application: "alpha-app" });
  await op(state, "os.register-app")(state, { id: "alpha", title: "Alpha", icon: "🅰", application: "alpha-app" });
  assert.equal(get(state, "os.apps").length, 1);
  assert.equal(get(state, "os.apps")[0].id, "alpha");
});

test("os.launch activates an app (no document)", async () => {
  const state = await boot();
  await op(state, "os.register-app")(state, { id: "alpha", application: "alpha-app" });
  await op(state, "os.launch")(state, "alpha");
  assert.equal(get(state, "os.active"), "alpha");
  assert.equal(get(state, "os.doc"), null);
});

test("os.launch with a document loads a user-space via session-segments", async () => {
  const state = await boot();
  await op(state, "os.register-app")(state, { id: "alpha", application: "alpha-app" });
  await op(state, "os.launch")(state, "alpha", "ah.doc1", { save: false });
  assert.ok(state.segments.has("ah.doc1"), "user-space hydrated");
  assert.equal(state.segments.get("ah.doc1").role, "user-space");
  assert.equal(state.segments.get("ah.doc1").applications[0], "alpha-app", "parented to the app");
  assert.equal(get(state, "os.active"), "alpha");
  assert.equal(get(state, "os.doc"), "ah.doc1");
});

test("os.switch changes the active app; os.exit returns to home", async () => {
  const state = await boot();
  await op(state, "os.launch")(state, "alpha", "ah.doc2", { save: false });
  await op(state, "os.switch")(state, "beta");
  assert.equal(get(state, "os.active"), "beta");
  await op(state, "os.exit")(state);
  assert.equal(get(state, "os.active"), "home");
  assert.equal(get(state, "os.doc"), null);
});
