import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, precompute, precomputeOptional, resolveFn } from "../dist/index.js";

const bootGraph = async () => {
  const state = createInitialState();
  const hydrate  = resolveFn(state,"hydrate");
  const runCycle = resolveFn(state,"runCycle");

  const userSeg = {
    name: "user",
    cels: [
      { key: "x", celType: "ValueCel", metadata: { key: "x", segment: "user", v: 2 } },
      { key: "y", celType: "ValueCel", metadata: { key: "y", segment: "user", v: 3 } },
      {
        key: "sum",
        celType: "FormulaCel",
        metadata: { key: "sum", segment: "user", parser: "f" },
        f: "(+ x y)",
      },
    ],
  };
  const userManifest = {
    name: "user", version: "0.0.1", description: "test", dependencies: [],
  };
  await hydrate(state, [userSeg], [userManifest]);
  precompute(state);
  await precomputeOptional(state);
  await runCycle(state);
  return state;
};

test("formula compiles and produces initial value", async () => {
  const state = await bootGraph();
  assert.equal(state.cels.get("sum")?.v, 5);
});

test("set propagates through formula cascade", async () => {
  const state = await bootGraph();
  const set = resolveFn(state,"set");
  await set(state, "x", 10);
  assert.equal(state.cels.get("sum")?.v, 13);
});

test("batch propagates one cascade per call", async () => {
  const state = await bootGraph();
  const batch = resolveFn(state,"batch");
  await batch(state, [["x", 7], ["y", 8]]);
  assert.equal(state.cels.get("sum")?.v, 15);
});

test("core fn cels are inert — they don't appear in waveCascade", async () => {
  const state = await bootGraph();
  const pcs = state.cels.get("precomputedStates").v;
  const inCascade = new Set();
  for (const levels of pcs.waveCascade.values()) {
    for (const level of levels) for (const k of level) inCascade.add(k);
  }
  assert.ok(inCascade.has("sum"), "user formula should be in cascade");
  for (const k of ["get", "set", "runCycle", "hydrate", "f"]) {
    assert.ok(!inCascade.has(k), `core fn cel "${k}" should NOT be in cascade`);
  }
});

test("set on a locked cel throws", async () => {
  const state = await bootGraph();
  const set = resolveFn(state,"set");
  await assert.rejects(
    async () => { await set(state, "precomputedStates", null); },
    /locked/,
  );
});

test("set on a fireable cel throws (use setCel)", async () => {
  const state = await bootGraph();
  const set = resolveFn(state,"set");
  // "sum" is a FormulaCel — direct set forbidden.
  await assert.rejects(
    async () => { await set(state, "sum", 0); },
    /compute path|setCel/,
  );
});

test("set on a missing cel throws", async () => {
  const state = await bootGraph();
  const set = resolveFn(state,"set");
  await assert.rejects(
    async () => { await set(state, "no_such_key", 0); },
    /unknown cel/,
  );
});
