import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn } from "../dist/index.js";

// dehydrate → JSON-serializable {segments, manifests}. Round-trip
// property: boot a state, mutate, dehydrate, build a fresh state,
// rehydrate, and observe the same cel values + same cascade behavior.
// The kernel segment is excluded from dehydrate output (re-seeded by
// createInitialState).

const mk = (name, dependencies = []) => ({
  name, version: "0.0.1", description: "test", dependencies,
});

test("dehydrate excludes the kernel segment", async () => {
  const state = createInitialState();
  const dehydrate = resolveFn(state, "dehydrate");
  const { segments, manifests } = await dehydrate(state);
  for (const m of manifests) assert.notEqual(m.name, "kernel");
  for (const s of segments)  assert.notEqual(s.name, "kernel");
});

test("user segment with value cels round-trips to identical values", async () => {
  const stateA = createInitialState();
  const hydrate   = resolveFn(stateA, "hydrate");
  const dehydrate = resolveFn(stateA, "dehydrate");
  const seg = {
    name: "user",
    cels: [
      { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", v: 42 } },
      { key: "b", celType: "ValueCel", metadata: { key: "b", segment: "user", v: "hello" } },
    ],
  };
  await hydrate(stateA, [seg], [mk("user")]);

  const dehydrated = await dehydrate(stateA);
  const json = JSON.parse(JSON.stringify(dehydrated));

  const stateB = createInitialState();
  const hydrateB = resolveFn(stateB, "hydrate");
  await hydrateB(stateB, json.segments, json.manifests);

  assert.equal(stateB.cels.get("a")?.v, 42);
  assert.equal(stateB.cels.get("b")?.v, "hello");
});

test("a FormulaCel round-trips and recomputes the same value", async () => {
  const stateA = createInitialState();
  const hydrate   = resolveFn(stateA, "hydrate");
  const dehydrate = resolveFn(stateA, "dehydrate");
  const runCycleA = resolveFn(stateA, "runCycle");
  const seg = {
    name: "user",
    cels: [
      { key: "x", celType: "ValueCel", metadata: { key: "x", segment: "user", v: 6 } },
      { key: "y", celType: "ValueCel", metadata: { key: "y", segment: "user", v: 7 } },
      {
        key: "prod",
        celType: "FormulaCel",
        metadata: { key: "prod", segment: "user", parser: "f" },
        f: "(* x y)",
      },
    ],
  };
  await hydrate(stateA, [seg], [mk("user")]);
  await precomputeOptional(stateA);
  await runCycleA(stateA);
  assert.equal(stateA.cels.get("prod")?.v, 42);

  const json = JSON.parse(JSON.stringify(await dehydrate(stateA)));

  const stateB = createInitialState();
  const hydrateB  = resolveFn(stateB, "hydrate");
  const runCycleB = resolveFn(stateB, "runCycle");
  await hydrateB(stateB, json.segments, json.manifests);
  await precomputeOptional(stateB);
  await runCycleB(stateB);
  assert.equal(stateB.cels.get("prod")?.v, 42, "formula recomputed after round-trip");
  assert.equal(stateB.cels.get("prod")?.f, "(* x y)", "source body preserved");
});

test("mutated state round-trips with the post-mutation values", async () => {
  const stateA = createInitialState();
  const hydrate   = resolveFn(stateA, "hydrate");
  const dehydrate = resolveFn(stateA, "dehydrate");
  const setA      = resolveFn(stateA, "set");
  const seg = {
    name: "user",
    cels: [
      { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", v: 1 } },
    ],
  };
  await hydrate(stateA, [seg], [mk("user")]);
  await setA(stateA, "a", 99);

  const json = JSON.parse(JSON.stringify(await dehydrate(stateA)));
  const stateB = createInitialState();
  const hydrateB = resolveFn(stateB, "hydrate");
  await hydrateB(stateB, json.segments, json.manifests);
  assert.equal(stateB.cels.get("a")?.v, 99, "post-mutation value carried through");
});

test("the manifest list round-trips with the dependencies preserved", async () => {
  const stateA = createInitialState();
  const hydrate   = resolveFn(stateA, "hydrate");
  const dehydrate = resolveFn(stateA, "dehydrate");
  const segs = [
    { name: "alpha", cels: [
      { key: "a1", celType: "ValueCel", metadata: { key: "a1", segment: "alpha", v: 1 } },
    ]},
    { name: "beta", cels: [
      { key: "b1", celType: "ValueCel", metadata: { key: "b1", segment: "beta", v: 1 } },
    ]},
  ];
  await hydrate(stateA, segs, [mk("alpha"), mk("beta", ["alpha"])]);

  const json = JSON.parse(JSON.stringify(await dehydrate(stateA)));
  const byName = new Map(json.manifests.map((m) => [m.name, m]));
  assert.deepEqual(byName.get("beta").dependencies, ["alpha"], "dependency edge preserved");
  assert.deepEqual(byName.get("alpha").dependencies, []);
});

test("registerLambda cels land in 'default' and dehydrate appears with a synthesized manifest", async () => {
  const state = createInitialState();
  const register  = resolveFn(state, "registerLambda");
  const dehydrate = resolveFn(state, "dehydrate");
  await register(state, { key: "myFn", fn: (x) => x + 1 });

  const { segments, manifests } = await dehydrate(state);
  const defaultSeg = segments.find((s) => s.name === "default");
  assert.ok(defaultSeg, "default segment exists in dehydrate output");
  assert.ok(defaultSeg.cels.some((c) => c.key === "myFn"), "myFn cel grouped under default");

  const defaultManifest = manifests.find((m) => m.name === "default");
  assert.ok(defaultManifest, "synthesized manifest exists so rehydrate accepts the segment");
});
