import { test } from "bun:test";
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

test("flush refuses builtins (kernel-closure protection from chunk A)", async () => {
  // Pre-chunk-A: flushing builtins with { force: true } removed its cels;
  // this test asserted the resulting "slow path errors cleanly" behavior.
  //
  // Post-chunk-A (segment-classification, 2026-05-24): builtins is a
  // dependency of the kernel manifest, so it's in the boot kernel
  // closure — unflushable regardless of `{ force: true }`. The test
  // now asserts the new contract: flush throws, cels survive, formula
  // evaluation continues to work.
  //
  // See 1-design/3-accepted/00-ontology/segment-classification.md
  // "Multi-segment kernel".
  const state = createInitialState();
  const flush         = resolveFn(state, "flush");
  const compileFormula = resolveFn(state, "f");

  const before = compileFormula("(+ a b)");
  assert.equal(before.fn({ "+": state.cels.get("+")._fn, a: 1, b: 2 }), 3);

  await assert.rejects(
    flush(state, "builtins", { force: true }),
    /kernel closure/,
  );
  for (const k of OPS) {
    assert.ok(state.cels.get(k), `cel "${k}" should survive — builtins is in kernel closure`);
  }
});
