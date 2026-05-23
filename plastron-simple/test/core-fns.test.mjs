import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

const CORE_FN_KEYS = [
  "get", "set", "update", "batch",
  "getCel", "setCel", "getCelBatch", "setCelBatch",
  "touch", "consume", "drain", "registerLambda", "clearErrors",
  "runCycle", "hydrate", "dehydrate", "flush",
  "getSegmentManifest", "listSegments", "findDependents",
  "f",
];

const LOCKED_CORE_FN_KEYS = CORE_FN_KEYS.filter((k) => k !== "f");

test("every core fn is reachable via resolveFn", () => {
  const state = createInitialState();
  for (const k of CORE_FN_KEYS) {
    assert.equal(typeof resolveFn(state, k), "function", `resolveFn(state, "${k}") should return a function`);
  }
});

test("every core fn is a LockedLambdaCel (or EditableLambdaCel for f) in state.cels with _fn populated", () => {
  const state = createInitialState();
  for (const k of CORE_FN_KEYS) {
    const cel = state.cels.get(k);
    assert.ok(cel, `cel "${k}" missing`);
    const expectedType = k === "f" ? "EditableLambdaCel" : "LockedLambdaCel";
    assert.equal(cel.celType, expectedType, `cel "${k}" wrong celType`);
    assert.equal(typeof cel._fn, "function", `cel "${k}" missing _fn`);
    assert.equal(cel.metadata.segment, "kernel", `cel "${k}" not in "kernel" segment`);
  }
});

test("locked core fns carry cel.locked === true; f stays unlocked", () => {
  const state = createInitialState();
  for (const k of LOCKED_CORE_FN_KEYS) {
    assert.equal(state.cels.get(k)?.locked, true, `cel "${k}".locked should be true`);
  }
  assert.notEqual(state.cels.get("f")?.locked, true, `cel "f" should be unlocked`);
});

test("formula compiler 'f' carries extractDeps for auto-wiring inputMap", () => {
  const state = createInitialState();
  const fFn = resolveFn(state, "f");
  assert.equal(typeof fFn.extractDeps, "function");
});

test("precomputedStates seed has a live PrecomputedIndexes (Maps + Set, not JSON)", () => {
  const state = createInitialState();
  const pcs = state.cels.get("precomputedStates");
  assert.ok(pcs, "precomputedStates cel missing");
  assert.equal(pcs.celType, "ValueCel");
  assert.ok(pcs.v.waveCascade instanceof Map, "waveCascade should be a Map");
  assert.ok(pcs.v.dynamicCascade instanceof Set, "dynamicCascade should be a Set");
});

test("kernel manifest is loaded into state.segments at boot", () => {
  const state = createInitialState();
  assert.ok(state.segments.get("kernel"), "kernel manifest missing");
});

test("no stray fns / fnMetadata / fnDispose maps on State", () => {
  const state = createInitialState();
  assert.equal("fns"        in state, false, "state.fns should not exist");
  assert.equal("fnMetadata" in state, false, "state.fnMetadata should not exist");
  assert.equal("fnDispose"  in state, false, "state.fnDispose should not exist");
});
