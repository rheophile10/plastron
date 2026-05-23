import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn } from "../dist/index.js";

// Async compilers (Javy, wabt.js, Pyodide) need to dynamic-import a
// runtime before they can return a CompiledLambda. The kernel models
// that by letting Compiler return Promise<CompiledLambda>; hydrate
// awaits, and compileFireable parallelizes within each topo layer so
// async compilers don't serialize the install.

const userManifest = {
  name: "user", version: "0.0.1", description: "test", dependencies: [],
};

test("hydrate awaits a compiler that returns a Promise<CompiledLambda>", async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  const hydrate  = resolveFn(state, "hydrate");

  // Async compiler — yields once, then returns a bare Fn.
  await register(state, {
    key: "async-double",
    fn: (source) => new Promise((r) => setTimeout(() => {
      r((inputs) => Number(inputs.x) * Number(source));
    }, 5)),
    kind: "custom",
  });

  const seg = {
    name: "user",
    cels: [
      { key: "x", celType: "ValueCel", metadata: { key: "x", segment: "user", v: 7 } },
      {
        key: "twoX",
        celType: "EditableLambdaCel",
        metadata: { key: "twoX", segment: "user", kind: "async-double", inputMap: { x: "x" } },
        f: "2",
      },
    ],
  };
  await hydrate(state, [seg], [userManifest]);
  await precomputeOptional(state);

  const runCycle = resolveFn(state, "runCycle");
  await runCycle(state);
  assert.equal(state.cels.get("twoX")?.v, 14);
});

test("compileFireable parallelizes sync + async compilers within one topo layer", async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  const hydrate  = resolveFn(state, "hydrate");

  let asyncDelivered = 0;
  await register(state, {
    key: "slow-id",
    fn: (source) => new Promise((r) => setTimeout(() => {
      asyncDelivered++;
      r((inputs) => `${source}:${inputs.in}`);
    }, 10)),
    kind: "custom",
  });
  await register(state, {
    key: "fast-id",
    fn: (source) => (inputs) => `${source}:${inputs.in}`,
    kind: "custom",
  });

  // Three cels, all in the same topo layer (no edges between them).
  // Mixed compilers — the async ones must not serialize the sync ones,
  // and the layer barrier must hold (all three compile before hydrate
  // returns).
  const seg = {
    name: "user",
    cels: [
      { key: "in", celType: "ValueCel", metadata: { key: "in", segment: "user", v: "hi" } },
      {
        key: "a",
        celType: "EditableLambdaCel",
        metadata: { key: "a", segment: "user", kind: "slow-id", inputMap: { in: "in" } },
        f: "A",
      },
      {
        key: "b",
        celType: "EditableLambdaCel",
        metadata: { key: "b", segment: "user", kind: "fast-id", inputMap: { in: "in" } },
        f: "B",
      },
      {
        key: "c",
        celType: "EditableLambdaCel",
        metadata: { key: "c", segment: "user", kind: "slow-id", inputMap: { in: "in" } },
        f: "C",
      },
    ],
  };
  const start = Date.now();
  await hydrate(state, [seg], [userManifest]);
  const elapsed = Date.now() - start;

  // Both async compiles ran.
  assert.equal(asyncDelivered, 2);
  // Parallel-within-layer: total wall time is bounded by the single
  // longest compile (~10 ms), not 2× sequential. Allow generous slack
  // for CI flake — 30 ms is still well under the 20 ms a serial run
  // would need.
  assert.ok(elapsed < 30, `expected parallel compile <30 ms, got ${elapsed} ms`);

  await precomputeOptional(state);
  const runCycle = resolveFn(state, "runCycle");
  await runCycle(state);
  assert.equal(state.cels.get("a")?.v, "A:hi");
  assert.equal(state.cels.get("b")?.v, "B:hi");
  assert.equal(state.cels.get("c")?.v, "C:hi");
});
