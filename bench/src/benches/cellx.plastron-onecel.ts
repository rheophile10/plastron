// ============================================================================
// cellx.plastron-onecel.ts — experimental.
//
// Same cellx workload, but expressed the way react-memo expresses it:
//   • One input cel `leaf0` for the leaf we mutate.
//   • One native-fn cel `compute` holding a JS fn that does the whole
//     topological walk and returns a Float64Array of all node values.
//     The initial leaves (other than leaf 0) and the wiring are captured
//     in the closure at construction time — they don't change between
//     ticks, so they're not cels.
//   • One formula cel `graph` whose formula is `(compute leaf0)`.
//
// Per tick: set leaf0 → one cascade fires for `graph` → compute runs
// the whole loop internally → done.
//
// Hypothesis: this should match react-memo's number at width=1000,
// because both reduce to "one cel/state update + one O(N) loop."
// Confirming would prove the 7–11× plastron-vs-react-memo gap in the
// per-cel cellx bench is entirely plastron's cascade machinery (one
// fire per cel × 5000 cels), not the work itself.
// ============================================================================

import { bench } from "../harness.js";
import { profile } from "../profile.js";
import { params } from "./params.js";
import type { Fn, Segment, State } from "../../../plastron/src/index.js";
import { createInitialState } from "../../../plastron/src/index.js";
import { precomputeOptional } from "../../../plastron/src/core/precompute.js";

const P = params.cellx;

const rng = (seed: number): (() => number) => {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

const pickDeps = (rand: () => number, width: number, fanIn: number): number[] => {
  const out = new Set<number>();
  while (out.size < fanIn) out.add(Math.floor(rand() * width));
  return [...out];
};

const flatIdx = (layer: number, i: number, width: number): number => layer * width + i;

const buildSegment = (width: number): Segment => {
  const layers = P.shared.layers;
  const fanIn = P.shared.fanIn;
  const rand = rng(P.shared.seed);

  // Mirror the per-cell variant's RNG sequence exactly: leaves first,
  // then per-layer dep picks in the same order. This guarantees the
  // same DAG wiring as cellx.plastron.ts and cellx.react-memo.ts.
  const initialLeaves: number[] = [];
  for (let i = 0; i < width; i++) initialLeaves.push(rand());

  const wiring: number[][][] = [[]];
  for (let layer = 1; layer < layers; layer++) {
    const layerWiring: number[][] = [];
    for (let i = 0; i < width; i++) {
      const local = pickDeps(rand, width, fanIn);
      layerWiring.push(local.map((d) => flatIdx(layer - 1, d, width)));
    }
    wiring.push(layerWiring);
  }

  // compute(leaf0Val) — closes over initialLeaves + wiring. Returns
  // the full graph values as a Float64Array.
  const compute = (leaf0Val: unknown): Float64Array => {
    const v = new Float64Array(width * layers);
    v[0] = Number(leaf0Val);
    for (let i = 1; i < width; i++) v[i] = initialLeaves[i]!;
    for (let layer = 1; layer < layers; layer++) {
      const lw = wiring[layer]!;
      for (let i = 0; i < width; i++) {
        const deps = lw[i]!;
        v[flatIdx(layer, i, width)] =
          (v[deps[0]!]! + v[deps[1]!]!) - (v[deps[2]!]! * v[deps[3]!]!);
      }
    }
    return v;
  };

  return {
    key: "cellx",
    cels: [
      { key: "leaf0", segment: "cellx", v: initialLeaves[0]! },
      { key: "compute", segment: "cellx", v: compute },
      { key: "graph", segment: "cellx", f: "(compute leaf0)" },
    ],
  };
};

interface Setup {
  state: State;
  set: Fn;
  counter: { v: number };
}

const setupFor = async (width: number): Promise<Setup> => {
  const state = createInitialState();
  const hydrate = state.fns.get("hydrate") as Fn;
  const runCycle = state.fns.get("runCycle") as Fn;
  const set = state.fns.get("set") as Fn;
  hydrate(state, [buildSegment(width)], [new Map()]);
  await runCycle(state);
  await precomputeOptional(state);
  return { state, set, counter: { v: 0 } };
};

const tick = async (s: Setup): Promise<void> => {
  s.counter.v += 1;
  await s.set(s.state, "leaf0", s.counter.v * 0.01);
};

const main = async (): Promise<void> => {
  const allTimings: Record<string, unknown> = {};
  const p = profile.start({ label: "cellx-plastron-onecel" });

  const sizes = P.plastronOneCel.sizes;
  let totalOps = 0;
  for (const width of sizes) {
    const total = width * P.shared.layers;
    process.stderr.write(`  cellx-onecel width=${width} (${total} nodes, 3 plastron cels)... `);
    const stats = await bench(
      () => setupFor(width),
      tick,
      { warmup: P.plastronOneCel.warmup(width), iterations: P.plastronOneCel.iterations(width) },
    );
    allTimings[`width=${width}`] = stats;
    totalOps += stats.n;
    process.stderr.write(`p50=${(stats.p50 / 1000).toFixed(1)}μs p99=${(stats.p99 / 1000).toFixed(1)}μs\n`);
  }

  const headline = allTimings[`width=${sizes[sizes.length - 1]}`] as ReturnType<typeof bench> extends Promise<infer R> ? R : never;
  const report = p.stop({
    timings: headline,
    opCount: totalOps,
    meta: { sizes: [...sizes], layers: P.shared.layers, fanIn: P.shared.fanIn, perSizeTimings: allTimings },
  });
  profile.emit(report);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
