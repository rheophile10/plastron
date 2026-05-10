// Quick microbench — measure hot-path overhead of the ref-cel changes.
//
// Three scenarios, run back-to-back so the comparison is apples-to-
// apples against the same V8 process:
//
//   1. Scalar chain (1-input) — original 100-cel arithmetic chain
//      a → b0 → b1 → … → b99 with every input a plain scalar cel.
//      Codegen emits the standard `(c.ref?_r(_s,c):c.v)` reads which
//      always take the .v branch. Tracks regression on the no-ref hot
//      path versus the previous baseline.
//
//   2. Scalar chain (2-input) — same 100-cel chain but each formula
//      reads from one prior link AND one extra scalar cel. Same
//      input-read cardinality as scenario 3 but with no refs, so the
//      delta between (3) and (2) isolates the cost of resolving through
//      a ref vs reading a scalar.
//
//   3. Ref chain (2-input, 1 ref/link) — same shape as (2), but the
//      extras are consolidated into a column so each rN is a ref cel.
//      Before the codegen-ref-awareness fix, every formula touching a
//      ref skipped _evaluate and fell back to slow-gather. After the
//      fix, codegen stays alive and emits inlined ref-aware reads.
//
// Run via `tsx src/microbench.ts`.

import type { Fn, Segment, State } from "../../../plastron/src/index.js";
import { createInitialState } from "../../../plastron/src/index.js";
import { installCollections } from "../../../segments/plastron-collections/src/install.js";
import { consolidateInPlace } from "../../../segments/plastron-collections/src/consolidate.js";

const N = 5000;

const benchScalar1 = async (): Promise<number> => {
  const state: State = createInitialState();
  const hydrate = state.fns.get("hydrate") as Fn;
  const runCycle = state.fns.get("runCycle") as Fn;
  const setFn = state.fns.get("set") as Fn;

  const cels: Segment["cels"] = [{ key: "a", v: 0, segment: "demo" }];
  for (let i = 0; i < 100; i++) {
    cels.push({
      key: `b${i}`,
      segment: "demo",
      f: i === 0 ? "(+ a 1)" : `(+ b${i - 1} 1)`,
    });
  }
  hydrate(state, [{ key: "demo", cels }], []);

  await runCycle(state);
  await new Promise((r) => setTimeout(r, 50));
  await runCycle(state);

  for (let i = 0; i < 100; i++) await setFn(state, "a", i);

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) await setFn(state, "a", i);
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1000;
};

const benchScalar2 = async (): Promise<number> => {
  const state: State = createInitialState();
  const hydrate = state.fns.get("hydrate") as Fn;
  const runCycle = state.fns.get("runCycle") as Fn;
  const setFn = state.fns.get("set") as Fn;

  const cels: Segment["cels"] = [{ key: "a", v: 0, segment: "demo" }];
  for (let i = 0; i < 100; i++) cels.push({ key: `r${i}`, v: 1, segment: "demo" });
  for (let i = 0; i < 100; i++) {
    cels.push({
      key: `b${i}`,
      segment: "demo",
      f: i === 0 ? `(+ a r${i})` : `(+ b${i - 1} r${i})`,
    });
  }
  hydrate(state, [{ key: "demo", cels }], []);
  await runCycle(state);
  await new Promise((r) => setTimeout(r, 50));
  await runCycle(state);

  for (let i = 0; i < 100; i++) await setFn(state, "a", i);

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) await setFn(state, "a", i);
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1000;
};

// Build a ref-bearing 100-cel chain, then measure either
//   • after the fix: codegen _evaluate stays alive on ref-input cels
//   • simulated before-the-fix: clear _evaluate on every ref-input cel
//     so fireCel falls back to the slow gather-and-call path
const benchRef2 = async (slowGather: boolean): Promise<number> => {
  const state: State = createInitialState();
  installCollections(state);
  const hydrate = state.fns.get("hydrate") as Fn;
  const runCycle = state.fns.get("runCycle") as Fn;
  const setFn = state.fns.get("set") as Fn;

  const cels: Segment["cels"] = [{ key: "a", v: 0, segment: "demo" }];
  for (let i = 0; i < 100; i++) cels.push({ key: `r${i}`, v: 1, segment: "demo" });
  for (let i = 0; i < 100; i++) {
    cels.push({
      key: `b${i}`,
      segment: "demo",
      f: i === 0 ? `(+ a r${i})` : `(+ b${i - 1} r${i})`,
    });
  }
  hydrate(state, [{ key: "demo", cels }], []);
  await runCycle(state);

  // Consolidate r0..r99 into a single column — each rN becomes a ref
  // cel pointing into slot N. After this every b{i} has a ref input,
  // and the codegen path must stay alive (this fix).
  const extras: string[] = [];
  for (let i = 0; i < 100; i++) extras.push(`r${i}`);
  await consolidateInPlace(state, extras, "extras", "f64");

  await new Promise((r) => setTimeout(r, 50));
  await runCycle(state);

  if (slowGather) {
    // Simulate the pre-fix behavior — `_evaluate` would never have
    // been populated for ref-input cels because precompute's
    // `hasRefInput` skip bailed before calling `_buildEvaluate`.
    // Clear it now so fireCel falls back to gather-and-call.
    for (let i = 0; i < 100; i++) {
      const c = state.cels.get(`b${i}`);
      if (c) c._evaluate = undefined;
    }
  }

  for (let i = 0; i < 100; i++) await setFn(state, "a", i);

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) await setFn(state, "a", i);
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1000;
};

const scalar1   = await benchScalar1();
const scalar2   = await benchScalar2();
const refBefore = await benchRef2(true);
const refAfter  = await benchRef2(false);

const fmt = (us: number): string => `${us.toFixed(0)} μs total = ${(us / N).toFixed(2)} μs/set`;
const pct = (a: number, b: number): string => {
  const d = ((a - b) / b) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`;
};

console.log(`microbench (100-cel chain, ${N} sets each):`);
console.log(`  1 — scalar chain, 1 input/link:                ${fmt(scalar1)}`);
console.log(`  2 — scalar chain, 2 inputs/link:               ${fmt(scalar2)}`);
console.log(`  3 — ref chain (slow-gather, simulated BEFORE): ${fmt(refBefore)}`);
console.log(`  4 — ref chain (codegen, AFTER fix):            ${fmt(refAfter)}`);
console.log(``);
console.log(`  ref AFTER vs BEFORE: ${pct(refAfter, refBefore)}  (negative = AFTER is faster)`);
console.log(`  ref AFTER vs scalar (matched 2-input shape): ${pct(refAfter, scalar2)}`);
console.log(`  (this fix reactivates codegen for ref-input cels; the residual`);
console.log(`   gap vs scalar is the per-input resolveValue call.)`);
