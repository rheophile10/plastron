// ============================================================================
// life.plastron.ts — Conway's Game of Life on an N×N toroidal grid.
//
// Cel layout per (x, y):
//   p_x_y  — value cel holding the *current* generation (0 or 1)
//   n_x_y  — formula cel computing the *next* generation from p_x_y +
//            its 8 wrapped neighbors. Uses one shared native-fn cel
//            `nextOf` (count, current) → 0|1.
//
// One tick:
//   1. Snapshot every n_x_y into a JS array.
//   2. Hand all N² writes to plastron's `batch` fn so the cascade fires
//      exactly once for the union of affected cels — no per-cell
//      cascade overhead.
//
// Reports throughput in generations/sec.
// ============================================================================

import { bench } from "../harness.js";
import { profile } from "../profile.js";
import { params } from "./params.js";
import type { Fn, Key, Segment, State } from "../../../plastron/src/index.js";
import { createInitialState } from "../../../plastron/src/index.js";
import { precomputeOptional } from "../../../plastron/src/core/precompute.js";

const P = params.life;

// Mulberry32 — small deterministic RNG so initial grids are reproducible.
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

const neighborKeys = (x: number, y: number, n: number): string[] => {
  const out: string[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      out.push(`p_${wrap(x + dx, n)}_${wrap(y + dy, n)}`);
    }
  }
  return out;
};

const buildSegment = (n: number, density: number, seed: number): Segment => {
  const rand = rng(seed);
  const cels: Segment["cels"] = [];

  // Native-fn cel: takes (sum-of-neighbors, current-value), returns 0 or 1.
  cels.push({
    key: "nextOf",
    segment: "life",
    v: (count: unknown, current: unknown): number => {
      const c = Number(count);
      const cur = Number(current);
      return c === 3 || (c === 2 && cur === 1) ? 1 : 0;
    },
  });

  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      cels.push({
        key: `p_${x}_${y}`,
        segment: "life",
        v: rand() < density ? 1 : 0,
      });
    }
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      const nbrs = neighborKeys(x, y, n).join(" ");
      cels.push({
        key: `n_${x}_${y}`,
        segment: "life",
        f: `(nextOf (+ ${nbrs}) p_${x}_${y})`,
      });
    }
  }
  return { key: "life", cels };
};

interface Setup {
  state: State;
  batch: Fn;
  n: number;
}

const setupFor = async (n: number): Promise<Setup> => {
  const state = createInitialState();
  const hydrate = state.fns.get("hydrate") as Fn;
  const runCycle = state.fns.get("runCycle") as Fn;
  const batch = state.fns.get("batch") as Fn;
  hydrate(state, [buildSegment(n, P.shared.initialDensity, P.shared.seed)], [new Map()]);
  await runCycle(state);
  await precomputeOptional(state);
  return { state, batch, n };
};

const tick = async (s: Setup): Promise<void> => {
  const { state, batch, n } = s;
  // 1. Snapshot every n_x_y into a writes array shaped for batch().
  const writes: Array<[Key, unknown]> = new Array(n * n);
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      const v = Number(state.cels.get(`n_${x}_${y}`)?.v ?? 0);
      writes[x * n + y] = [`p_${x}_${y}`, v];
    }
  }
  // 2. One batch call → one cascade for the union of affected cels.
  await batch(state, writes);
};

const main = async (): Promise<void> => {
  const allTimings: Record<string, unknown> = {};
  const p = profile.start({ label: "life-plastron" });

  let totalOps = 0;
  const sizes = P.plastron.sizes;
  for (const n of sizes) {
    process.stderr.write(`  life n=${n}×${n} (${n * n} cels)... `);
    const stats = await bench(
      () => setupFor(n),
      tick,
      { warmup: P.plastron.warmup(n), iterations: P.plastron.iterations(n) },
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
