// ============================================================================
// life.plastron-onecel.ts — "plastron used correctly" for the Life
// workload.
//
// Cels are at the I/O boundary only:
//   • tickCounter — value cel. Bumped each iteration to drive the
//                   formula. The number itself isn't meaningful; only
//                   the *change* matters as a reactivity trigger.
//   • step        — function-value cel. Closes over a mutable
//                   "current grid" Uint8Array and grid dimensions.
//                   Each call: advances the grid by one generation
//                   (writes into a scratch buffer, swaps pointers),
//                   returns the new generation count.
//   • generation  — formula cel `(step tickCounter)`. Plastron fires
//                   this single cascade per tick; Life's O(N²) work
//                   happens inside the native fn.
//
// The grid lives in `step`'s closure, mirroring how react-memo holds
// it inside useState. Plastron sees only the tick input and the
// generation output; the actual state is opaque to the cascade.
// ============================================================================

import { bench } from "../harness.js";
import { profile } from "../profile.js";
import { params } from "./params.js";
import type { Fn, Segment, State } from "../../../plastron/src/index.js";
import { createInitialState } from "../../../plastron/src/index.js";
import { precomputeOptional } from "../../../plastron/src/core/precompute.js";

const P = params.life;

const rng = (seed: number): (() => number) => {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

const wrap = (i: number, n: number): number => ((i % n) + n) % n;

const buildSegment = (n: number): Segment => {
  const rand = rng(P.shared.seed);
  let grid = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) grid[i] = rand() < P.shared.initialDensity ? 1 : 0;
  let next = new Uint8Array(n * n);
  let generation = 0;

  // step(tick) — advances the closure-captured grid by one generation
  // and returns the new generation count. The cascade fires once per
  // tick change; the work is internal.
  const step = (_tick: unknown): number => {
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        let count = 0;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            count += grid[wrap(x + dx, n) * n + wrap(y + dy, n)]!;
          }
        }
        const self = grid[x * n + y]!;
        next[x * n + y] = count === 3 || (count === 2 && self === 1) ? 1 : 0;
      }
    }
    const tmp = grid;
    grid = next;
    next = tmp;
    return ++generation;
  };

  return {
    key: "life",
    cels: [
      { key: "tickCounter", segment: "life", v: 0 },
      { key: "step",        segment: "life", v: step },
      { key: "generation",  segment: "life", f: "(step tickCounter)" },
    ],
  };
};

interface Setup {
  state: State;
  set: Fn;
  tickCounter: { v: number };
}

const setupFor = async (n: number): Promise<Setup> => {
  const state = createInitialState();
  const hydrate = state.fns.get("hydrate") as Fn;
  const runCycle = state.fns.get("runCycle") as Fn;
  const set = state.fns.get("set") as Fn;
  hydrate(state, [buildSegment(n)], [new Map()]);
  await runCycle(state);
  await precomputeOptional(state);
  return { state, set, tickCounter: { v: 0 } };
};

const tick = async (s: Setup): Promise<void> => {
  s.tickCounter.v += 1;
  await s.set(s.state, "tickCounter", s.tickCounter.v);
};

const main = async (): Promise<void> => {
  const allTimings: Record<string, unknown> = {};
  const p = profile.start({ label: "life-plastron-onecel" });

  let totalOps = 0;
  const sizes = P.plastronOneCel.sizes;
  for (const n of sizes) {
    process.stderr.write(`  life-onecel n=${n}×${n} (${n * n} cells, 3 plastron cels)... `);
    const stats = await bench(
      () => setupFor(n),
      tick,
      { warmup: P.plastronOneCel.warmup(n), iterations: P.plastronOneCel.iterations(n) },
    );
    allTimings[`n=${n}`] = stats;
    totalOps += stats.n;
    process.stderr.write(`p50=${(stats.p50 / 1_000_000).toFixed(2)}ms p99=${(stats.p99 / 1_000_000).toFixed(2)}ms\n`);
  }

  const headline = allTimings[`n=${sizes[sizes.length - 1]}`] as ReturnType<typeof bench> extends Promise<infer R> ? R : never;
  const report = p.stop({
    timings: headline,
    opCount: totalOps,
    meta: { sizes: [...sizes], perSizeTimings: allTimings, cellsPerGen: sizes.map((n) => n * n) },
  });
  profile.emit(report);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
