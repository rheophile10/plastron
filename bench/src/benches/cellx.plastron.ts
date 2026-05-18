// ============================================================================
// cellx.plastron.ts — synthetic layered reactive graph (cellx-style).
//
// Standard reactive-microbench shape:
//   Layer 0      — N leaf value cels.
//   Layer 1..K   — N formula cels per layer; each depends on `fanIn`
//                  random cells from the prior layer.
//   Formula     — `(- (+ a b) (* c d))` for fanIn=4. Gives a non-
//                 trivial scalar that exercises both + and * builtins
//                 and changes sensitively to any input.
//
// Per iteration we flip one leaf cel and measure cascade time. This is
// the canonical signal-lib microbenchmark — comparable numbers exist
// for cellx, S.js, Solid signals, Preact signals, MobX, etc.
//
// Sizes (layer width): 100, 500, 1000. Total cels = sizes × layers.
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

const nodeKey = (layer: number, idx: number): string => `c_${layer}_${idx}`;

// Pick `fanIn` distinct indices in [0, width) using the RNG. Deterministic
// for a given seed + layer + idx, so plastron + react variants build the
// same graph.
const pickDeps = (rand: () => number, width: number, fanIn: number): number[] => {
  const out = new Set<number>();
  while (out.size < fanIn) out.add(Math.floor(rand() * width));
  return [...out];
};

const buildSegment = (width: number, layers: number, fanIn: number, seed: number): Segment => {
  const cels: Segment["cels"] = [];
  const rand = rng(seed);

  // Layer 0 — leaves.
  for (let i = 0; i < width; i++) {
    cels.push({
      key: nodeKey(0, i),
      segment: "cellx",
      v: rand(),
    });
  }
  // Layers 1..K-1 — formula cels with fan-in deps from prior layer.
  for (let layer = 1; layer < layers; layer++) {
    for (let i = 0; i < width; i++) {
      const depIdx = pickDeps(rand, width, fanIn);
      const refs = depIdx.map((d) => nodeKey(layer - 1, d));
      // Fixed 4-arg formula when fanIn === 4 — most common config.
      // For other fanIn we fall through to a simpler sum.
      const formula =
        fanIn === 4
          ? `(- (+ ${refs[0]} ${refs[1]}) (* ${refs[2]} ${refs[3]}))`
          : `(+ ${refs.join(" ")})`;
      cels.push({
        key: nodeKey(layer, i),
        segment: "cellx",
        f: formula,
      });
    }
  }
  return { key: "cellx", cels };
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
  hydrate(state, [buildSegment(width, P.shared.layers, P.shared.fanIn, P.shared.seed)], [new Map()]);
  await runCycle(state);
  await precomputeOptional(state);
  return { state, set, counter: { v: 0 } };
};

const tick = async (s: Setup): Promise<void> => {
  // Flip leaf 0 — cascade propagates through layers.
  s.counter.v += 1;
  await s.set(s.state, nodeKey(0, 0), s.counter.v * 0.01);
};

const main = async (): Promise<void> => {
  const allTimings: Record<string, unknown> = {};
  const p = profile.start({ label: "cellx-plastron" });

  let totalOps = 0;
  const sizes = P.plastron.sizes;
  for (const width of sizes) {
    const total = width * P.shared.layers;
    process.stderr.write(`  cellx width=${width} (${total} cels, ${P.shared.layers} layers)... `);
    const stats = await bench(
      () => setupFor(width),
      tick,
      { warmup: P.plastron.warmup(width), iterations: P.plastron.iterations(width) },
    );
    allTimings[`width=${width}`] = stats;
    totalOps += stats.n;
    process.stderr.write(`p50=${(stats.p50 / 1000).toFixed(1)}μs p99=${(stats.p99 / 1000).toFixed(1)}μs\n`);
  }

  const headline = allTimings[`width=${sizes[sizes.length - 1]}`] as ReturnType<typeof bench> extends Promise<infer R> ? R : never;
  const report = p.stop({
    timings: headline,
    opCount: totalOps,
    meta: {
      sizes: [...sizes],
      layers: P.shared.layers,
      fanIn: P.shared.fanIn,
      perSizeTimings: allTimings,
    },
  });
  profile.emit(report);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
