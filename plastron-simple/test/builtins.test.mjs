import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

const OPS = ["+", "-", "*", "/"];

test("builtins segment installs + - * / as LockedLambdaCels with _fn", () => {
  const state = createInitialState();
  for (const k of OPS) {
    const cel = state.cels.get(k);
    assert.ok(cel, `cel "${k}" missing`);
    assert.equal(cel.celType, "LockedLambdaCel", `cel "${k}" wrong celType`);
    assert.equal(typeof cel._fn, "function", `cel "${k}" missing _fn`);
    assert.equal(cel.metadata.segment, "builtins", `cel "${k}" wrong segment`);
    assert.equal(cel.locked, true, `cel "${k}" should be locked`);
  }
});

test("builtin cels carry impls matching the old hardcoded BUILTINS table", () => {
  const state = createInitialState();
  const plus  = state.cels.get("+")._fn;
  const minus = state.cels.get("-")._fn;
  const times = state.cels.get("*")._fn;
  const div   = state.cels.get("/")._fn;

  assert.equal(plus(),         0);
  assert.equal(plus(1, 2, 3),  6);
  assert.equal(times(),        1);
  assert.equal(times(2, 3, 4), 24);
  assert.equal(minus(),        0);
  assert.equal(minus(5),       -5);
  assert.equal(minus(10, 3),   7);
  assert.equal(Number.isNaN(div()), true);
  assert.equal(div(4),         0.25);
  assert.equal(div(20, 5),     4);
  assert.equal(plus("1", "2"), 3); // Number() coercion preserved
});

test("flushing the builtins segment removes the cels and slow-path formula evaluation errors cleanly", async () => {
  const state = createInitialState();
  const flush         = resolveFn(state, "flush");
  const compileFormula = resolveFn(state, "f");

  // Sanity: while installed, the slow path resolves "+" through inputs.
  const before = compileFormula("(+ a b)");
  assert.equal(before.fn({ "+": state.cels.get("+")._fn, a: 1, b: 2 }), 3);

  // Force because the kernel manifest declares builtins as a dep.
  await flush(state, "builtins", { force: true });
  for (const k of OPS) {
    assert.equal(state.cels.get(k), undefined, `cel "${k}" should be gone after flush`);
  }

  // With "+" no longer in inputs, the slow path now errors cleanly
  // instead of silently succeeding via the old hardcoded BUILTINS table.
  const after = compileFormula("(+ 1 2)");
  assert.throws(
    () => after.fn({}),
    /Formula references "\+" but it isn't a function\./,
  );
});
