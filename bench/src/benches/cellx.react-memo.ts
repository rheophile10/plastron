// ============================================================================
// cellx.react-memo.ts — idiomatic React cellx.
//
// Single <Graph> component:
//   • Wiring (which 4 cells each non-leaf node depends on) is computed
//     once at setup and passed in as a prop.
//   • useState holds the values Float64Array.
//   • useEffect on [tick] applies one cascade: write the new leaf 0
//     value into a copy of the array, then walk layers in topo order
//     recomputing each non-leaf node from its deps.
//
// One render + one effect per tick, no per-cell hooks. Mirrors the
// plastron cellx wiring exactly (same RNG seed → same deps).
// ============================================================================

import * as React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { bench } from "../harness.js";
import { profile } from "../profile.js";
import { params } from "./params.js";

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

interface Wiring {
  width: number;
  layers: number;
  /** wiring[layer][i] = [dep0Idx, dep1Idx, dep2Idx, dep3Idx] as flat values-array indices. */
  wiring: number[][][];
  /** Initial leaf values (length = width). */
  initialLeaves: number[];
}

const buildWiring = (width: number): Wiring => {
  const layers = P.shared.layers;
  const fanIn = P.shared.fanIn;
  const rand = rng(P.shared.seed);
  const initialLeaves = Array.from({ length: width }, () => rand());
  const wiring: number[][][] = [[]];
  for (let layer = 1; layer < layers; layer++) {
    const layerWiring: number[][] = [];
    for (let i = 0; i < width; i++) {
      const local = pickDeps(rand, width, fanIn);
      layerWiring.push(local.map((d) => flatIdx(layer - 1, d, width)));
    }
    wiring.push(layerWiring);
  }
  return { width, layers, wiring, initialLeaves };
};

const compute = (values: Float64Array, w: Wiring): Float64Array => {
  const out = new Float64Array(values);
  for (let layer = 1; layer < w.layers; layer++) {
    const layerWiring = w.wiring[layer]!;
    for (let i = 0; i < w.width; i++) {
      const deps = layerWiring[i]!;
      out[flatIdx(layer, i, w.width)] =
        (out[deps[0]!]! + out[deps[1]!]!) - (out[deps[2]!]! * out[deps[3]!]!);
    }
  }
  return out;
};

interface GraphProps {
  w: Wiring;
  leafRef: { v: number };
  tick: number;
}

const Graph: React.FC<GraphProps> = ({ w, leafRef, tick }) => {
  const [values, setValues] = React.useState<Float64Array>(() => {
    const v = new Float64Array(w.width * w.layers);
    for (let i = 0; i < w.width; i++) v[i] = w.initialLeaves[i]!;
    return compute(v, w);
  });
  React.useEffect(() => {
    if (tick === 0) return;
    setValues((prev) => {
      const seeded = new Float64Array(prev);
      seeded[0] = leafRef.v;
      return compute(seeded, w);
    });
  }, [tick, w, leafRef]);
  void values;
  return null;
};

interface Setup {
  renderer: TestRenderer.ReactTestRenderer;
  w: Wiring;
  leafRef: { v: number };
  tickRef: { v: number };
}

const setupFor = async (width: number): Promise<Setup> => {
  const w = buildWiring(width);
  const leafRef = { v: w.initialLeaves[0]! };
  const tickRef = { v: 0 };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Graph, { w, leafRef, tick: tickRef.v }));
  });
  await act(async () => { /* flush */ });
  return { renderer, w, leafRef, tickRef };
};

const tick = async (s: Setup): Promise<void> => {
  s.tickRef.v += 1;
  s.leafRef.v = s.tickRef.v * 0.01;
  await act(async () => {
    s.renderer.update(React.createElement(Graph, {
      w: s.w, leafRef: s.leafRef, tick: s.tickRef.v,
    }));
  });
};

const main = async (): Promise<void> => {
  const allTimings: Record<string, unknown> = {};
  const p = profile.start({ label: "cellx-react-memo" });

  let totalOps = 0;
  const sizes = P.reactMemo.sizes;
  for (const width of sizes) {
    const total = width * P.shared.layers;
    process.stderr.write(`  cellx-memo width=${width} (${total} cels, ${P.shared.layers} layers)... `);
    const stats = await bench(
      () => setupFor(width),
      tick,
      { warmup: P.reactMemo.warmup(width), iterations: P.reactMemo.iterations(width) },
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
