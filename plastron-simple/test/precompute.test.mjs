import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precompute, precomputeOptional, resolveFn } from "../dist/index.js";

// Direct inspection of indexes.precomputedStates — wave/level structure,
// downstream lazy cache, dynamic cascade, cycle detection.

const userManifest = {
  name: "user", version: "0.0.1", description: "test", dependencies: [],
};

const indexesOf = (state) => state.cels.get("precomputedStates")?.v;

const bootDiamond = async () => {
  // diamond:  src → left → out
  //           src → right → out
  // levels expected:  [src? — no, ValueCels aren't fireable]
  // fireable members in waveCascade: left, right (level 0), out (level 1).
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const seg = {
    name: "user",
    cels: [
      { key: "src", celType: "ValueCel", metadata: { key: "src", segment: "user", v: 5 } },
      {
        key: "left",
        celType: "FormulaCel",
        metadata: { key: "left", segment: "user", parser: "f" },
        f: "(* src 2)",
      },
      {
        key: "right",
        celType: "FormulaCel",
        metadata: { key: "right", segment: "user", parser: "f" },
        f: "(* src 3)",
      },
      {
        key: "out",
        celType: "FormulaCel",
        metadata: { key: "out", segment: "user", parser: "f" },
        f: "(+ left right)",
      },
    ],
  };
  await hydrate(state, [seg], [userManifest]);
  await precomputeOptional(state);
  return state;
};

test("waveCascade groups fireable cels by wave; same-wave levels are Kahn-sorted", async () => {
  const state = await bootDiamond();
  const idx = indexesOf(state);
  assert.ok(idx, "indexes present");
  assert.deepEqual(idx.sortedWaves, [0], "all cels default to wave 0");
  const levels = idx.waveCascade.get(0);
  assert.ok(levels, "wave 0 levels present");
  // left + right have no in-wave upstream (src is not fireable, doesn't
  // count), so they share level 0. out depends on both → level 1.
  const flatLevel0 = new Set(levels[0]);
  assert.ok(flatLevel0.has("left"),  "left at level 0");
  assert.ok(flatLevel0.has("right"), "right at level 0");
  assert.equal(flatLevel0.has("out"), false, "out NOT at level 0");
  assert.ok(levels[1].includes("out"), "out at level 1");
});

test("children is reverse adjacency: src → {left, right}", async () => {
  const state = await bootDiamond();
  const idx = indexesOf(state);
  const srcKids = idx.children.get("src");
  assert.ok(srcKids, "src has children");
  assert.ok(srcKids.has("left") && srcKids.has("right"));
  const leftKids = idx.children.get("left");
  assert.ok(leftKids?.has("out"), "left → out");
});

test("downstream is a lazy memoized cache — empty until first affectedFor call", async () => {
  const state = await bootDiamond();
  const idx = indexesOf(state);
  assert.equal(idx.downstream.size, 0, "fresh precompute leaves downstream empty");

  // A set call invokes affectedFor, which fills the cache for the
  // written key.
  const set = resolveFn(state, "set");
  await set(state, "src", 7);
  assert.ok(idx.downstream.has("src"), "downstream(src) cached on first write");
  const dsSrc = idx.downstream.get("src");
  assert.ok(dsSrc.has("left") && dsSrc.has("right") && dsSrc.has("out"),
    "closure of src includes the full diamond");
});

test("a fresh precompute pass wipes downstream and bumps the generation token", async () => {
  const state = await bootDiamond();
  const set = resolveFn(state, "set");
  await set(state, "src", 11); // populate downstream cache + bump generation
  const idxBefore = indexesOf(state);
  const genBefore = state.precomputeGeneration;
  assert.ok(idxBefore.downstream.size > 0, "cache has entries");

  precompute(state);
  const idxAfter = indexesOf(state);
  assert.equal(idxAfter.downstream.size, 0, "downstream emptied");
  assert.equal(state.precomputeGeneration, genBefore + 1, "generation bumped");
});

test("dynamicCascade is the union of every dynamic seed + its downstream", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const seg = {
    name: "user",
    cels: [
      { key: "leaf", celType: "ValueCel", metadata: { key: "leaf", segment: "user", v: 0 } },
      {
        key: "clock",
        celType: "FormulaCel",
        metadata: { key: "clock", segment: "user", parser: "f" },
        dynamic: true,
        f: "(* leaf 2)",
      },
      {
        key: "downstreamOfClock",
        celType: "FormulaCel",
        metadata: { key: "downstreamOfClock", segment: "user", parser: "f" },
        f: "(+ clock 1)",
      },
    ],
  };
  await hydrate(state, [seg], [userManifest]);
  await precomputeOptional(state);
  const idx = indexesOf(state);
  assert.ok(idx.dynamicCascade.has("clock"), "dynamic seed in cascade");
  assert.ok(idx.dynamicCascade.has("downstreamOfClock"),
    "everything downstream of a dynamic cel rides along");
  assert.equal(idx.dynamicCascade.has("leaf"), false,
    "leaf is upstream of clock — not in dynamicCascade");
});

test("a dependency cycle in the cel graph is rejected at hydrate", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  // a ← b ← a — formula parser auto-wires inputMap from the body, so
  // referencing each other in their formulas creates the cycle. The
  // first-pass precompute (called inside hydrate) should reject.
  const seg = {
    name: "user",
    cels: [
      {
        key: "a",
        celType: "FormulaCel",
        metadata: { key: "a", segment: "user", parser: "f" },
        f: "(+ b 1)",
      },
      {
        key: "b",
        celType: "FormulaCel",
        metadata: { key: "b", segment: "user", parser: "f" },
        f: "(+ a 1)",
      },
    ],
  };
  await assert.rejects(
    () => hydrate(state, [seg], [userManifest]),
    /[Cc]ycle/,
  );
});
