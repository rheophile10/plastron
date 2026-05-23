import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn } from "../dist/index.js";

// batch and update — the multi-write and read-transform-write
// convenience fns on top of `set`. Both share `set`'s cascade-and-flush
// shape; batch coalesces N writes into one runCascade pass.

const userManifest = {
  name: "user", version: "0.0.1", description: "test", dependencies: [],
};

const bootSumProd = async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const seg = {
    name: "user",
    cels: [
      { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", v: 2 } },
      { key: "b", celType: "ValueCel", metadata: { key: "b", segment: "user", v: 3 } },
      {
        key: "sum",
        celType: "FormulaCel",
        metadata: { key: "sum", segment: "user", parser: "f" },
        f: "(+ a b)",
      },
      {
        key: "prod",
        celType: "FormulaCel",
        metadata: { key: "prod", segment: "user", parser: "f" },
        f: "(* a b)",
      },
    ],
  };
  await hydrate(state, [seg], [userManifest]);
  await precomputeOptional(state);
  const runCycle = resolveFn(state, "runCycle");
  await runCycle(state);
  return state;
};

test("update applies fn(current) and propagates the cascade", async () => {
  const state  = await bootSumProd();
  const update = resolveFn(state, "update");
  await update(state, "a", (v) => v + 10);
  assert.equal(state.cels.get("a")?.v, 12);
  assert.equal(state.cels.get("sum")?.v,  15, "sum = a+b updated");
  assert.equal(state.cels.get("prod")?.v, 36, "prod = a*b updated");
});

test("update receives undefined when the cel doesn't exist, then throws on write", async () => {
  const state  = await bootSumProd();
  const update = resolveFn(state, "update");
  // The fn runs once (with undefined), then writeOne throws on the
  // missing cel — matching set's behavior for unknown keys.
  let received;
  await assert.rejects(
    () => update(state, "no_such", (v) => { received = v; return 1; }),
    /unknown cel/,
  );
  assert.equal(received, undefined);
});

test("batch fires the cascade once for multiple writes", async () => {
  const state    = await bootSumProd();
  const register = resolveFn(state, "registerLambda");
  // Replace sum's parser path: install a side-effecting counter cel
  // whose fn increments every time it's called.
  let sumFires = 0;
  await register(state, {
    key: "countingPlus",
    fn: (a, b) => { sumFires++; return Number(a) + Number(b); },
    kind: "custom",
  });
  const setCel = resolveFn(state, "setCel");
  await setCel(state, "sum", { f: "(countingPlus a b)" });
  await precomputeOptional(state);
  sumFires = 0;

  const batch = resolveFn(state, "batch");
  await batch(state, [["a", 7], ["b", 8]]);
  assert.equal(sumFires, 1, "batch coalesces a+b into one cascade pass");
  assert.equal(state.cels.get("sum")?.v, 15);
});

test("set-in-a-loop fires the cascade N times (regression contrast for batch)", async () => {
  const state    = await bootSumProd();
  const register = resolveFn(state, "registerLambda");
  let sumFires = 0;
  await register(state, {
    key: "countingPlus",
    fn: (a, b) => { sumFires++; return Number(a) + Number(b); },
    kind: "custom",
  });
  const setCel = resolveFn(state, "setCel");
  await setCel(state, "sum", { f: "(countingPlus a b)" });
  await precomputeOptional(state);
  sumFires = 0;

  const set = resolveFn(state, "set");
  await set(state, "a", 7);
  await set(state, "b", 8);
  assert.equal(sumFires, 2, "each set fires its own cascade");
});

test("batch with duplicate keys keeps the last write's value", async () => {
  const state = await bootSumProd();
  const batch = resolveFn(state, "batch");
  await batch(state, [["a", 5], ["a", 100]]);
  assert.equal(state.cels.get("a")?.v, 100, "last write wins");
  assert.equal(state.cels.get("sum")?.v, 103, "cascade sees the final value");
});

test("batch is atomic on the write phase — fireable cel rejection leaves graph untouched", async () => {
  const state = await bootSumProd();
  const batch = resolveFn(state, "batch");
  const aBefore   = state.cels.get("a")?.v;
  const sumBefore = state.cels.get("sum")?.v;
  // `a` would succeed, `sum` (FormulaCel) fails validation. Pre-flight
  // catches sum BEFORE any mutation, so `a` is never written.
  await assert.rejects(
    () => batch(state, [["a", 50], ["sum", 999]]),
    /compute path|setCel/,
  );
  assert.equal(state.cels.get("a")?.v, aBefore, "no partial write on 'a'");
  assert.equal(state.cels.get("sum")?.v, sumBefore, "sum untouched");
});

test("batch atomically rejects on an unknown cel — earlier valid writes don't commit", async () => {
  const state = await bootSumProd();
  const batch = resolveFn(state, "batch");
  const aBefore = state.cels.get("a")?.v;
  const bBefore = state.cels.get("b")?.v;
  await assert.rejects(
    () => batch(state, [["a", 50], ["b", 60], ["nonexistent", 1]]),
    /unknown cel/,
  );
  assert.equal(state.cels.get("a")?.v, aBefore, "a never committed");
  assert.equal(state.cels.get("b")?.v, bBefore, "b never committed");
});

test("batch atomically rejects on a locked cel — earlier valid writes don't commit", async () => {
  const state = await bootSumProd();
  const batch = resolveFn(state, "batch");
  const aBefore = state.cels.get("a")?.v;
  await assert.rejects(
    // precomputedStates is a locked ValueCel.
    () => batch(state, [["a", 50], ["precomputedStates", null]]),
    /is locked/,
  );
  assert.equal(state.cels.get("a")?.v, aBefore, "a never committed despite preceding the failing write");
});

test("batch with the rejecting cel FIRST behaves identically (validation is pre-flight, not inline)", async () => {
  const state = await bootSumProd();
  const batch = resolveFn(state, "batch");
  const aBefore = state.cels.get("a")?.v;
  await assert.rejects(
    () => batch(state, [["nonexistent", 1], ["a", 50]]),
    /unknown cel/,
  );
  assert.equal(state.cels.get("a")?.v, aBefore, "ordering doesn't matter — all-or-nothing");
});

test("batch with no writes returns state without firing", async () => {
  const state = await bootSumProd();
  const batch = resolveFn(state, "batch");
  const sumBefore = state.cels.get("sum")?.v;
  const result = await batch(state, []);
  assert.equal(result, state);
  assert.equal(state.cels.get("sum")?.v, sumBefore);
});
