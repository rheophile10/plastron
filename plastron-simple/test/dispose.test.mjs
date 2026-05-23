import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

test("registered cel carries _dispose when args.dispose was provided", async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  await register(state, { key: "withDispose", fn: () => 1, dispose: () => {} });
  assert.equal(typeof state.cels.get("withDispose")._dispose, "function");
});

test("re-register fires the previous _dispose once", async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  let fired = 0;
  await register(state, { key: "wd", fn: () => 1, dispose: () => { fired++; } });
  await register(state, { key: "wd", fn: () => 2 });
  assert.equal(fired, 1);
});

test("re-register without a new dispose clears cel._dispose", async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  await register(state, { key: "wd", fn: () => 1, dispose: () => {} });
  await register(state, { key: "wd", fn: () => 2 });
  assert.equal(state.cels.get("wd")._dispose, undefined);
});

test("re-register with a new dispose installs it on the cel", async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  await register(state, { key: "wd", fn: () => 1, dispose: () => {} });
  let secondFired = 0;
  await register(state, { key: "wd", fn: () => 2, dispose: () => { secondFired++; } });
  // Trigger by registering again — the second dispose should fire on the
  // third registration.
  await register(state, { key: "wd", fn: () => 3 });
  assert.equal(secondFired, 1);
});

test("a dispose that throws does not halt registration", async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  await register(state, {
    key: "wd",
    fn: () => 1,
    dispose: () => { throw new Error("oops"); },
  });
  // Re-register must not propagate the dispose error.
  await assert.doesNotReject(() => register(state, { key: "wd", fn: () => 2 }));
  assert.equal(resolveFn(state, "wd")(), 2);
});

test("no fnDispose Map on State (dispose lives on cel._dispose)", () => {
  const state = createInitialState();
  assert.equal("fnDispose" in state, false);
});
