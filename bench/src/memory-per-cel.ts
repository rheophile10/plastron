// ============================================================================
// memory-per-cel — measure heap cost per cel for several cel shapes.
//
// Reports incremental heapUsed delta after instantiating N cels of a
// given shape. Divide by N to get the average bytes per cel.
//
// Shapes:
//   • valueCel     — bare value cel, { key, v: 0 }. Floor for cel cost.
//   • formulaCel   — { key, f: "(+ a 1)" }, with a single upstream
//                    input. Adds the parsed AST + compiled fn.
//   • lambdaCel    — { key, l: "add", inputMap: {a, b} }, where "add"
//                    is registered as a native Fn. No source string.
//   • formulaWithEvaluate — formula cel after `precomputeOptional`
//                    runs, so cel._evaluate (the codegen closure)
//                    is also resident. The full fast-path footprint.
//
// Run with --expose-gc for stable numbers:
//     node --expose-gc --import tsx src/memory-per-cel.ts
//
// Without --expose-gc, results have noise from prior allocations. The
// harness still reports them but flags the configuration in the output.
// ============================================================================

import {
  environment, memDelta, memSnapshot, writeResults,
} from "./harness.js";
import type { Fn, Segment } from "../../plastron/src/index.js";
import { createInitialState } from "../../plastron/src/index.js";
import { precomputeOptional } from "../../plastron/src/core/precompute.js";

const SIZES = [100, 1_000, 10_000, 100_000] as const;

const HAS_GC =
  typeof (globalThis as unknown as { gc?: () => void }).gc === "function";

const forceGc = (): void => {
  const g = (globalThis as unknown as { gc?: () => void }).gc;
  if (g) {
    // Run gc twice; the second pass collects newly-promoted garbage
    // from the first.
    g(); g();
  }
};

// ── Shape generators ─────────────────────────────────────────────────────────

const valueSegment = (n: number): Segment => {
  const cels = [];
  for (let i = 0; i < n; i++) {
    cels.push({ key: `v${i}`, v: 0, segment: "bench" });
  }
  return { key: "bench", cels };
};

const formulaSegment = (n: number): Segment => {
  const cels = [];
  cels.push({ key: "a", v: 0, segment: "bench" });
  for (let i = 0; i < n; i++) {
    cels.push({ key: `f${i}`, segment: "bench", f: "(+ a 1)" });
  }
  return { key: "bench", cels };
};

const lambdaSegment = (n: number): Segment => {
  const cels = [];
  cels.push({ key: "a", v: 0, segment: "bench" });
  cels.push({ key: "b", v: 0, segment: "bench" });
  for (let i = 0; i < n; i++) {
    cels.push({
      key: `m${i}`, segment: "bench",
      l: "add", inputMap: { a: "a", b: "b" },
    });
  }
  return { key: "bench", cels };
};

// ── Single shape × size measurement ──────────────────────────────────────────

interface Result {
  shape: string;
  n: number;
  /** Total heapUsed delta from before-hydrate to after-hydrate, in bytes. */
  heapDelta: number;
  /** Bytes per cel (heapDelta / n). */
  bytesPerCel: number;
  /** Whether the fast-path (_evaluate) was populated for this measurement. */
  evaluatePopulated: boolean;
}

const measure = async (
  shape: "value" | "formula" | "lambda" | "formulaEvaluated",
  n: number,
): Promise<Result> => {
  const state = createInitialState();

  // For lambda shape, register a native add fn.
  if (shape === "lambda") {
    state.fns.set("add", ((inputs: { a: number; b: number }) => inputs.a + inputs.b) as Fn);
    state.fnMetadata.set("add", { key: "add" });
  }

  const segment =
    shape === "value"  ? valueSegment(n) :
    shape === "lambda" ? lambdaSegment(n) :
                         formulaSegment(n); // formula and formulaEvaluated

  const hydrate = state.fns.get("hydrate") as Fn;
  const runCycle = state.fns.get("runCycle") as Fn;

  // Establish the post-init baseline (state, fns, fnMetadata, etc.
  // already allocated). The cel-incremental cost is what we want.
  forceGc();
  const before = memSnapshot();

  hydrate(state, [segment], [new Map()]);
  await runCycle(state);

  if (shape === "formulaEvaluated") {
    await precomputeOptional(state);
  } else {
    // For other shapes, optional-pass populates _inputEntries (cheap)
    // but no _evaluate (no buildEvaluate from native fn at "add").
    await precomputeOptional(state);
  }

  // Hold the state ref alive past the GC so it doesn't get collected.
  forceGc();
  const after = memSnapshot();
  const delta = memDelta(before, after);

  // Sanity: verify the state still has the expected cel count, just
  // to keep it live across the measurement.
  const cellCount = state.cels.size;
  if (cellCount < n) {
    throw new Error(`unexpected cell count: ${cellCount} < ${n}`);
  }

  return {
    shape,
    n,
    heapDelta: delta.heapUsed,
    bytesPerCel: delta.heapUsed / n,
    evaluatePopulated: shape === "formulaEvaluated",
  };
};

// ── Run all configurations ──────────────────────────────────────────────────

const main = async (): Promise<void> => {
  if (!HAS_GC) {
    console.warn("⚠  --expose-gc is OFF. Numbers will be noisy.");
    console.warn("    Re-run with: node --expose-gc --import tsx src/memory-per-cel.ts");
    console.warn();
  }

  const startedAt = new Date().toISOString();
  console.log(`memory-per-cel — started ${startedAt}`);
  console.log();

  const results: Result[] = [];
  const shapes = ["value", "formula", "lambda", "formulaEvaluated"] as const;

  for (const shape of shapes) {
    console.log(`  ${shape}:`);
    for (const n of SIZES) {
      const r = await measure(shape, n);
      console.log(
        `    n=${n.toString().padStart(7)}  ` +
        `Δheap=${(r.heapDelta / 1024 / 1024).toFixed(2).padStart(8)} MB  ` +
        `per-cel=${r.bytesPerCel.toFixed(0).padStart(6)} B`,
      );
      results.push(r);
    }
    console.log();
  }

  const path = writeResults("memory-per-cel", {
    bench: "memory-per-cel",
    exposeGc: HAS_GC,
    environment: environment(),
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
  });
  console.log(`  results → ${path}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
