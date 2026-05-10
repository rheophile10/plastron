// ============================================================================
// cascade-shape — measure cascade time vs graph shape × size.
//
// Three shapes:
//   • linear   — c0 ← c1 ← c2 ← ... ← cN. Worst case for parallelism;
//                each cel waits on its predecessor. Tests pure cascade
//                propagation cost.
//   • fanOut   — root ← c1, c2, ..., cN. All children depend on root.
//                Tests within-level Promise.all over many siblings.
//   • fanIn    — l1, l2, ..., lN ← sink. One downstream consumer reads
//                all leaves. Tests gather cost on the consumer.
//
// For each shape × N ∈ {10, 100, 1000, 10000}, we report:
//   • full-cycle time (runCycle from scratch)
//   • set-and-cascade time (set the root, await the affected cascade)
//
// Both measured AFTER the optional precompute pass has populated
// _evaluate / _inputEntries — that's the fast-path number. To compare
// against the slow path, set BENCH_NO_OPTIONAL=1 and the bench will
// skip the await + manually clear _evaluate before each set.
// ============================================================================

import {
  bench, environment, printStats, writeResults,
} from "./harness.js";
import type { Fn, Segment, State } from "../../plastron/src/index.js";
import { createInitialState } from "../../plastron/src/index.js";
import { precomputeOptional } from "../../plastron/src/core/precompute.js";

// Shape-specific size caps. Linear chains beyond ~5000 hit a recursive
// stack overflow in plastron's buildDownstream — that's a real bug to
// file separately, but the bench shouldn't crash. Fan-out and fan-in
// have shallow downstream closures and run fine at 10k.
const SIZES = {
  linear: [10, 100, 1000, 5000] as const,
  fanOut: [10, 100, 1000, 10000] as const,
  fanIn:  [10, 100, 1000, 10000] as const,
};
const SHAPES = ["linear", "fanOut", "fanIn"] as const;

const SKIP_OPTIONAL = process.env.BENCH_NO_OPTIONAL === "1";

// ── Graph generators ────────────────────────────────────────────────────────

const linearSegment = (n: number): Segment => {
  const cels = [];
  // c0 is the root: a value cel.
  cels.push({ key: "c0", v: 0, segment: "bench" });
  // c1..cN: each adds 1 to its predecessor.
  for (let i = 1; i <= n; i++) {
    cels.push({
      key: `c${i}`,
      segment: "bench",
      f: `(+ c${i - 1} 1)`,
    });
  }
  return { key: "bench", cels };
};

const fanOutSegment = (n: number): Segment => {
  const cels = [];
  cels.push({ key: "root", v: 0, segment: "bench" });
  for (let i = 0; i < n; i++) {
    cels.push({
      key: `c${i}`,
      segment: "bench",
      f: "(+ root 1)",
    });
  }
  return { key: "bench", cels };
};

const fanInSegment = (n: number): Segment => {
  const cels = [];
  for (let i = 0; i < n; i++) {
    cels.push({ key: `l${i}`, v: i, segment: "bench" });
  }
  // sink reads all leaves and sums them. Use multi-arity (+ ...).
  const leafRefs = Array.from({ length: n }, (_, i) => `l${i}`).join(" ");
  cels.push({
    key: "sink",
    segment: "bench",
    f: `(+ ${leafRefs})`,
  });
  return { key: "bench", cels };
};

const generators = { linear: linearSegment, fanOut: fanOutSegment, fanIn: fanInSegment };

// ── Single configuration ─────────────────────────────────────────────────────

interface Config {
  shape: typeof SHAPES[number];
  n: number;
}

interface Setup {
  state: State;
  set: Fn;
  runCycle: Fn;
  rootKey: string;
  counter: { v: number };
}

const setup = async (cfg: Config): Promise<Setup> => {
  const state = createInitialState();
  const segment = generators[cfg.shape](cfg.n);
  const hydrate = state.fns.get("hydrate") as Fn;
  const runCycle = state.fns.get("runCycle") as Fn;
  const set = state.fns.get("set") as Fn;

  hydrate(state, [segment], [new Map()]);
  await runCycle(state);

  // Settle the optional pass — populates _evaluate so we measure the
  // fast path. When SKIP_OPTIONAL is set, fall through and the bench
  // measures the medium path (cached _inputEntries, no _evaluate).
  if (!SKIP_OPTIONAL) {
    await precomputeOptional(state);
  } else {
    // Defensively clear any closures the auto-scheduled pass may have
    // landed before we got here (it runs as a microtask).
    for (const cel of state.cels.values()) cel._evaluate = undefined;
  }

  const rootKey =
    cfg.shape === "linear" ? "c0" :
    cfg.shape === "fanOut" ? "root" :
    "l0"; // fanIn: bumping any leaf cascades into sink

  return { state, set, runCycle, rootKey, counter: { v: 1 } };
};

const setAndCascade = async (s: Setup): Promise<void> => {
  await s.set(s.state, s.rootKey, s.counter.v++);
};

// ── Run all configurations ──────────────────────────────────────────────────

const main = async (): Promise<void> => {
  const startedAt = new Date().toISOString();
  console.log(`cascade-shape — started ${startedAt}`);
  console.log(`  optional pass: ${SKIP_OPTIONAL ? "SKIPPED (slow path)" : "active (fast path)"}`);
  console.log();

  const results: Array<{ shape: string; n: number; setAndCascade: ReturnType<typeof statsRow> }> = [];

  for (const shape of SHAPES) {
    console.log(`  ${shape}:`);
    for (const n of SIZES[shape]) {
      // For fanIn, the formula uses a multi-arity (+) over n inputs;
      // n=10000 makes the formula source ~80 KB. The S-expr compiler
      // handles it but the codegen body is also large. Keep going.
      try {
        const stats = await bench(
          () => setup({ shape, n }),
          setAndCascade,
          { warmup: 20, iterations: 100 },
        );
        const label = `cels=${n}`;
        printStats(label, stats);
        results.push({ shape, n, setAndCascade: statsRow(stats) });
      } catch (err) {
        console.log(`    cels=${n.toString().padStart(6)}  FAILED: ${(err as Error).message}`);
      }
    }
    console.log();
  }

  const path = writeResults("cascade-shape", {
    bench: "cascade-shape",
    optionalPass: !SKIP_OPTIONAL,
    environment: environment(),
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
  });
  console.log(`  results → ${path}`);
};

const statsRow = (s: ReturnType<typeof bench> extends Promise<infer R> ? R : never): {
  n: number; p50: number; p95: number; p99: number; mean: number; cv: number;
} => ({ n: s.n, p50: s.p50, p95: s.p95, p99: s.p99, mean: s.mean, cv: s.cv });

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
