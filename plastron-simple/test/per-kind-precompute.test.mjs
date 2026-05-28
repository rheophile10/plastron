import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createInitialState, precompute, precomputeOptional, resolveFn, kindOf,
} from "../dist/index.js";

const baseManifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };

// ── kindOf helper ───────────────────────────────────────────────────────────

test("kindOf returns 'js' for FormulaCels", () => {
  const cel = { celType: "FormulaCel", metadata: { key: "x", parser: "f" } };
  assert.equal(kindOf(cel), "js");
});

test("kindOf returns metadata.kind for LambdaCels", () => {
  const wat = { celType: "EditableLambdaCel", metadata: { key: "x", kind: "wat" } };
  const js  = { celType: "EditableLambdaCel", metadata: { key: "x", kind: "js" } };
  const nat = { celType: "LockedLambdaCel",   metadata: { key: "x", kind: "native" } };
  assert.equal(kindOf(wat), "wat");
  assert.equal(kindOf(js),  "js");
  assert.equal(kindOf(nat), "native");
});

test("kindOf defaults to 'js' when LambdaCel has no metadata.kind", () => {
  const cel = { celType: "EditableLambdaCel", metadata: { key: "x" } };
  assert.equal(kindOf(cel), "js");
});

// ── waveCascadeByKind shape ─────────────────────────────────────────────────

test("waveCascadeByKind partitions each level by cel kind", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");

  // Build a mixed-kind graph: 2 JS formulas + 1 wat lambda + 1 formula
  // calling the wat lambda. All in wave 0.
  const seg = {
    name: "user",
    cels: [
      { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", v: 5 } },
      { key: "b", celType: "ValueCel", metadata: { key: "b", segment: "user", v: 7 } },
      { key: "js-sum", celType: "FormulaCel",
        metadata: { key: "js-sum", segment: "user", parser: "f" },
        f: "(+ a b)" },
      { key: "wat-mul", celType: "EditableLambdaCel",
        // Opt the lambda into the cascade explicitly. Compilers don't
        // populate inputMap for lambda kinds anymore (only formula
        // parsers do); without an opt-in, lambdas stay out of the
        // cascade as pure function-cels.
        metadata: { key: "wat-mul", segment: "user", kind: "wat", inputMap: {} },
        dynamic: true,
        f: "(module (func (export \"main\") (param $a i32) (param $b i32) (result i32) " +
           "local.get $a local.get $b i32.mul))" },
      { key: "wat-result", celType: "FormulaCel",
        metadata: { key: "wat-result", segment: "user", parser: "f" },
        f: "(wat-mul a b)" },
    ],
  };
  await hydrate(state, [seg], [baseManifest]);
  precompute(state);
  await precomputeOptional(state);

  const indexes = state.cels.get("precomputedStates").v;
  assert.ok(indexes.waveCascadeByKind instanceof Map, "waveCascadeByKind should be a Map");

  // Collect every (kind, key) pair across all waves and levels.
  const allByKind = new Map();
  for (const levels of indexes.waveCascadeByKind.values()) {
    for (const level of levels) {
      for (const [k, keys] of level) {
        let bucket = allByKind.get(k);
        if (!bucket) { bucket = new Set(); allByKind.set(k, bucket); }
        for (const key of keys) bucket.add(key);
      }
    }
  }

  // js-sum and wat-result are both FormulaCels → "js"
  // wat-mul is a wat lambda → "wat"
  const js = allByKind.get("js") ?? new Set();
  assert.ok(js.has("js-sum"),     "js-sum should be in 'js' bucket");
  assert.ok(js.has("wat-result"), "wat-result (FormulaCel) should be in 'js' bucket");

  const wat = allByKind.get("wat") ?? new Set();
  assert.ok(wat.has("wat-mul"), "wat-mul should be in 'wat' bucket");
});

test("waveCascadeByKind preserves topo order within each kind partition", async () => {
  // A → B (both wat), so B must fire after A within its kind bucket.
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");

  const seg = {
    name: "user",
    cels: [
      { key: "x", celType: "ValueCel", metadata: { key: "x", segment: "user", v: 4 } },
      { key: "double", celType: "EditableLambdaCel",
        metadata: { key: "double", segment: "user", kind: "wat" },
        f: "(module (func (export \"main\") (param $a i32) (result i32) " +
           "local.get $a i32.const 2 i32.mul))" },
      { key: "A", celType: "FormulaCel",
        metadata: { key: "A", segment: "user", parser: "f" },
        f: "(double x)" },
      { key: "B", celType: "FormulaCel",
        metadata: { key: "B", segment: "user", parser: "f" },
        f: "(double A)" },
    ],
  };
  await hydrate(state, [seg], [baseManifest]);
  precompute(state);

  const indexes = state.cels.get("precomputedStates").v;
  // Find the level where A is placed and the level where B is placed.
  let aLevel = -1, bLevel = -1;
  for (const levels of indexes.waveCascadeByKind.values()) {
    for (let i = 0; i < levels.length; i++) {
      const jsBucket = levels[i].get("js") ?? [];
      if (jsBucket.includes("A")) aLevel = i;
      if (jsBucket.includes("B")) bLevel = i;
    }
  }
  assert.ok(aLevel >= 0, "A should appear in some level");
  assert.ok(bLevel >= 0, "B should appear in some level");
  assert.ok(aLevel < bLevel, `A (level ${aLevel}) must precede B (level ${bLevel})`);
});

// ── waveCascade and waveCascadeByKind agree on membership ──────────────────

test("waveCascade and waveCascadeByKind contain the same set of keys", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");

  const seg = {
    name: "user",
    cels: [
      { key: "p", celType: "ValueCel", metadata: { key: "p", segment: "user", v: 3 } },
      { key: "q", celType: "ValueCel", metadata: { key: "q", segment: "user", v: 4 } },
      { key: "add", celType: "EditableLambdaCel",
        metadata: { key: "add", segment: "user", kind: "wat" },
        f: "(module (func (export \"main\") (param $a i32) (param $b i32) (result i32) " +
           "local.get $a local.get $b i32.add))" },
      { key: "sum", celType: "FormulaCel",
        metadata: { key: "sum", segment: "user", parser: "f" },
        f: "(add p q)" },
    ],
  };
  await hydrate(state, [seg], [baseManifest]);
  precompute(state);

  const indexes = state.cels.get("precomputedStates").v;
  const fromCascade = new Set();
  for (const levels of indexes.waveCascade.values()) {
    for (const level of levels) {
      for (const k of level) fromCascade.add(k);
    }
  }
  const fromByKind = new Set();
  for (const levels of indexes.waveCascadeByKind.values()) {
    for (const level of levels) {
      for (const [, keys] of level) {
        for (const k of keys) fromByKind.add(k);
      }
    }
  }
  assert.deepEqual(
    [...fromCascade].sort(),
    [...fromByKind].sort(),
    "waveCascadeByKind must contain exactly the same keys as waveCascade",
  );
});

// ── empty kind buckets are NOT materialized ────────────────────────────────

test("a kind that doesn't appear in a level produces no bucket for it", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");

  // JS-only graph: no wat cels anywhere.
  const seg = {
    name: "user",
    cels: [
      { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", v: 1 } },
      { key: "b", celType: "ValueCel", metadata: { key: "b", segment: "user", v: 2 } },
      { key: "sum", celType: "FormulaCel",
        metadata: { key: "sum", segment: "user", parser: "f" },
        f: "(+ a b)" },
    ],
  };
  await hydrate(state, [seg], [baseManifest]);
  precompute(state);

  const indexes = state.cels.get("precomputedStates").v;
  for (const levels of indexes.waveCascadeByKind.values()) {
    for (const level of levels) {
      assert.equal(level.has("wat"), false, "no 'wat' bucket should exist in a JS-only graph");
      // The level must always have a 'js' bucket (or be empty entirely).
      if (level.size > 0) assert.ok(level.has("js"));
    }
  }
});

// ── runCycle still works (we didn't change dispatch) ───────────────────────

test("runCycle continues to fire cels correctly with kind-batched precompute in place", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");

  const seg = {
    name: "user",
    cels: [
      { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", v: 6 } },
      { key: "b", celType: "ValueCel", metadata: { key: "b", segment: "user", v: 7 } },
      { key: "mul", celType: "EditableLambdaCel",
        metadata: { key: "mul", segment: "user", kind: "wat" },
        f: "(module (func (export \"main\") (param $a i32) (param $b i32) (result i32) " +
           "local.get $a local.get $b i32.mul))" },
      { key: "product", celType: "FormulaCel",
        metadata: { key: "product", segment: "user", parser: "f" },
        f: "(mul a b)" },
    ],
  };
  await hydrate(state, [seg], [baseManifest]);
  precompute(state);
  await precomputeOptional(state);
  await runCycle(state);

  assert.equal(state.cels.get("product").v, 42);
});
