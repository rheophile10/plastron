// ============================================================================
// cellx.react.ts — same fan-in DAG as cellx.plastron.ts via per-node
// useState + useEffect.
//
// The graph is a fan-in DAG (each node has K parents from prior layer),
// which can't be expressed as a React tree without sharing state via
// a ref. So:
//   • A single Float64Array `values` holds every node's current value.
//   • Each <Node> reads its `depIds`' values from `values` during a
//     useEffect, computes, writes its own slot back, and setState's
//     its own React-visible value.
//   • Per tick, we flip leaf 0's value and then `act()`-flush each
//     layer in turn by bumping a per-layer generation prop. This
//     guarantees topological propagation — the layer-1 effects fire
//     after layer-0's `values` write is committed.
//
// Per tick cost:
//   • 1 leaf flip
//   • For each layer 1..K: trigger that layer's gen → all its nodes
//     re-render → each node fires its useEffect once → read deps from
//     `values`, compute, write own slot.
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

// idx in the global values array: layer * width + i.
const flatIdx = (layer: number, i: number, width: number): number => layer * width + i;

interface NodeProps {
  id: number;
  depIds: number[] | null;     // null for leaf nodes
  values: Float64Array;
  generation: number;
}

const Node: React.FC<NodeProps> = ({ id, depIds, values, generation }) => {
  const [v, setV] = React.useState<number>(values[id]!);
  React.useEffect(() => {
    let next: number;
    if (!depIds) {
      // Leaf: just publish whatever leaves were set to externally.
      next = values[id]!;
    } else if (depIds.length === 4) {
      // (a + b) - (c * d)
      const a = values[depIds[0]!]!;
      const b = values[depIds[1]!]!;
      const c = values[depIds[2]!]!;
      const d = values[depIds[3]!]!;
      next = (a + b) - (c * d);
    } else {
      let sum = 0;
      for (const d of depIds) sum += values[d]!;
      next = sum;
    }
    values[id] = next;
    if (next !== v) setV(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);
  return null;
};

interface LayerProps {
  nodes: NodeProps[];
  generation: number;
}

const Layer: React.FC<LayerProps> = ({ nodes, generation }) => {
  const els: React.ReactElement[] = [];
  for (const n of nodes) {
    els.push(React.createElement(Node, {
      key: n.id, id: n.id, depIds: n.depIds, values: n.values, generation,
    }));
  }
  return React.createElement(React.Fragment, null, ...els);
};

interface GraphProps {
  layerNodes: NodeProps[][];
  gens: number[];
}

const Graph: React.FC<GraphProps> = ({ layerNodes, gens }) => {
  const els: React.ReactElement[] = [];
  for (let i = 0; i < layerNodes.length; i++) {
    els.push(React.createElement(Layer, {
      key: i, nodes: layerNodes[i]!, generation: gens[i]!,
    }));
  }
  return React.createElement(React.Fragment, null, ...els);
};

interface Setup {
  renderer: TestRenderer.ReactTestRenderer;
  values: Float64Array;
  layerNodes: NodeProps[][];
  gens: number[];
  width: number;
  counter: { v: number };
}

const setupFor = async (width: number): Promise<Setup> => {
  const layers = P.shared.layers;
  const fanIn = P.shared.fanIn;
  const rand = rng(P.shared.seed);
  const values = new Float64Array(width * layers);
  // Leaves get random values; non-leaf slots stay 0 until first render.
  for (let i = 0; i < width; i++) values[i] = rand();
  // Build per-layer NodeProps. The rng calls below must mirror those
  // in cellx.plastron.ts so both build the same graph wiring.
  const layerNodes: NodeProps[][] = [];
  // Leaves.
  {
    const leafs: NodeProps[] = [];
    for (let i = 0; i < width; i++) {
      leafs.push({
        id: flatIdx(0, i, width),
        depIds: null,
        values,
        generation: 0,
      });
    }
    layerNodes.push(leafs);
  }
  // Inner layers.
  for (let layer = 1; layer < layers; layer++) {
    const nodes: NodeProps[] = [];
    for (let i = 0; i < width; i++) {
      const depLocal = pickDeps(rand, width, fanIn);
      const depIds = depLocal.map((d) => flatIdx(layer - 1, d, width));
      nodes.push({
        id: flatIdx(layer, i, width),
        depIds,
        values,
        generation: 0,
      });
    }
    layerNodes.push(nodes);
  }
  const gens = new Array<number>(layers).fill(0);

  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Graph, { layerNodes, gens }));
  });
  await act(async () => { /* flush initial effects */ });

  return { renderer, values, layerNodes, gens, width, counter: { v: 0 } };
};

const tick = async (s: Setup): Promise<void> => {
  s.counter.v += 1;
  // 1. Flip leaf 0. Write directly to the values array; we still need
  //    the leaf node's useEffect to fire so its useState is in sync,
  //    so bump the leaf layer's generation.
  s.values[flatIdx(0, 0, s.width)] = s.counter.v * 0.01;
  // 2. Propagate one layer at a time so each layer's effects see fresh
  //    upstream values.
  for (let layer = 0; layer < s.gens.length; layer++) {
    s.gens[layer] = (s.gens[layer] ?? 0) + 1;
    await act(async () => {
      s.renderer.update(React.createElement(Graph, {
        layerNodes: s.layerNodes,
        gens: [...s.gens],
      }));
    });
  }
};

const main = async (): Promise<void> => {
  const allTimings: Record<string, unknown> = {};
  const p = profile.start({ label: "cellx-react" });

  let totalOps = 0;
  const sizes = P.react.sizes;
  for (const width of sizes) {
    const total = width * P.shared.layers;
    process.stderr.write(`  cellx-react width=${width} (${total} cels, ${P.shared.layers} layers)... `);
    const stats = await bench(
      () => setupFor(width),
      tick,
      { warmup: P.react.warmup(width), iterations: P.react.iterations(width) },
    );
    allTimings[`width=${width}`] = stats;
    totalOps += stats.n;
    process.stderr.write(`p50=${(stats.p50 / 1_000_000).toFixed(2)}ms p99=${(stats.p99 / 1_000_000).toFixed(2)}ms\n`);
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
