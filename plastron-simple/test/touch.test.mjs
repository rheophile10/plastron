import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn } from "../dist/index.js";

// touch / consume / drain — "trigger an effect without writing a cel".
// touch and consume both fire indexes.dynamicCascade with an empty
// `changed` set, so only cels marked `dynamic: true` actually re-fire;
// drain settles channels without touching the graph.

const userManifest = {
  name: "user", version: "0.0.1", description: "test", dependencies: [],
};

const bootWithDynamic = async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  const hydrate  = resolveFn(state, "hydrate");

  let counter = 0;
  await register(state, {
    key: "tick",
    fn: () => ++counter,
    kind: "custom",
  });

  // Formula `(tick)` — extractDeps wires `tick` into inputMap; the
  // formula parser calls it at fire time. `dynamic: true` keeps the
  // cel in indexes.dynamicCascade so touch re-fires it.
  const seg = {
    name: "user",
    cels: [
      {
        key: "clock",
        celType: "FormulaCel",
        metadata: { key: "clock", segment: "user", parser: "f" },
        dynamic: true,
        f: "(tick)",
      },
    ],
  };
  await hydrate(state, [seg], [userManifest]);
  await precomputeOptional(state);
  return { state, getCounter: () => counter };
};

test("touch re-fires every cel with dynamic: true", async () => {
  const { state, getCounter } = await bootWithDynamic();
  const runCycle = resolveFn(state, "runCycle");
  const touch    = resolveFn(state, "touch");

  await runCycle(state);
  const baseline = getCounter();
  assert.ok(baseline >= 1, "dynamic cel fires at boot");

  await touch(state);
  assert.equal(getCounter(), baseline + 1, "touch fires dynamic cel once");
  await touch(state);
  assert.equal(getCounter(), baseline + 2, "every touch call fires it again");
});

test("touch does NOT fire non-dynamic cels", async () => {
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  const hydrate  = resolveFn(state, "hydrate");

  let nonDynFires = 0;
  await register(state, {
    key: "noteFire",
    fn: (_x) => { nonDynFires++; return null; },
    kind: "custom",
  });

  // No `dynamic` flag — should fire only when `src` changes.
  const seg = {
    name: "user",
    cels: [
      { key: "src", celType: "ValueCel", metadata: { key: "src", segment: "user", v: 1 } },
      {
        key: "obs",
        celType: "FormulaCel",
        metadata: { key: "obs", segment: "user", parser: "f" },
        f: "(noteFire src)",
      },
    ],
  };
  await hydrate(state, [seg], [userManifest]);
  await precomputeOptional(state);

  const runCycle = resolveFn(state, "runCycle");
  const touch    = resolveFn(state, "touch");
  await runCycle(state);
  const baseline = nonDynFires;
  await touch(state);
  await touch(state);
  assert.equal(nonDynFires, baseline, "touch must not fire non-dynamic cels");
});

test("consume is a semantic alias of touch — same fire shape", async () => {
  const { state, getCounter } = await bootWithDynamic();
  const runCycle = resolveFn(state, "runCycle");
  const consume  = resolveFn(state, "consume");
  await runCycle(state);
  const before = getCounter();
  await consume(state);
  assert.equal(getCounter(), before + 1, "consume fires dynamic cel like touch");
});

test("drain returns without throwing when nothing is pending", async () => {
  const state = createInitialState();
  const drain = resolveFn(state, "drain");
  await drain(state);
  await drain(state, "nonexistent-channel");
});
