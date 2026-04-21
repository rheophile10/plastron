import type { Key } from "../../common.js";
import type { State } from "../types/index.js";
import type { Cel } from "../types/cel.js";
import type { WavedCascade } from "../cycle/types.js";
import type {
  DownstreamTopology, DynamicCascade, DynamicKeys,
} from "../segments/types/index.js";

// ========================================================================
// precompute — pure graph math over an already-hydrated State. Writes
// results into the reserved index cels (segment "indexes") and stamps
// per-cel layer/wave onto each cel directly.
//
// Hydration has already validated keys, expanded formulas, schema-checked
// initial values, and bound cel._fn / cel._lambdaMeta / cel._inputRefs.
// This pass produces only the graph-shape artifacts.
// ========================================================================

type Topology = Key[][];
type TopologyIndex = Map<Key, number>;
type DownstreamClosure = Map<Key, Set<Key>>;
type CelMap = Map<Key, Cel>;

export const precompute = (state: State): void => {
  const cels = state.Cels;

  const { topology, index: topologyIndex } = buildTopology(cels);

  for (const [key, layerIdx] of topologyIndex) {
    const cel = cels.get(key);
    if (cel) cel.layer = layerIdx;
  }

  const waveOfKey = buildWaves(cels, topology);

  const downstreamClosure = buildDownstreamClosure(cels, topology);
  const downstreamTopology = buildDownstreamTopology(downstreamClosure, topologyIndex, waveOfKey);
  setIndex(cels, "downstreamTopology", downstreamTopology);

  const { dynamicKeys, dynamicCascade } = buildDynamicIndexes(cels, downstreamClosure, topologyIndex);
  setIndex(cels, "dynamicKeys", dynamicKeys);
  setIndex(cels, "dynamicCascade", dynamicCascade);
};

const setIndex = (cels: CelMap, key: Key, value: unknown): void => {
  const cel = cels.get(key);
  if (cel) cel.v = value;
};

// ========================================================================
// Kahn's topological sort — layered on cel.children edges.
// ========================================================================

const buildTopology = (cels: CelMap): { topology: Topology; index: TopologyIndex } => {
  const graph = new Map<Key, Set<Key>>();
  const inDegree = new Map<Key, number>();
  const allKeys = Array.from(cels.keys());

  for (const key of allKeys) {
    graph.set(key, new Set());
    inDegree.set(key, 0);
  }

  for (const [key, cel] of cels) {
    if (cel.children?.length) {
      for (const childKey of cel.children) {
        if (!cels.has(childKey)) continue;
        graph.get(key)!.add(childKey);
        inDegree.set(childKey, (inDegree.get(childKey) ?? 0) + 1);
      }
    }
  }

  const topology: Topology = [];
  const index: TopologyIndex = new Map();
  const queue: Key[] = [];
  let currentLayer = 0;

  for (const key of allKeys) {
    if (inDegree.get(key) === 0) queue.push(key);
  }

  let processed = 0;

  while (queue.length > 0) {
    const layerSize = queue.length;
    const layer: Key[] = [];

    for (let i = 0; i < layerSize; i++) {
      const key = queue.shift()!;
      layer.push(key);
      index.set(key, currentLayer);
      processed++;

      for (const dependent of graph.get(key) ?? []) {
        const newDegree = inDegree.get(dependent)! - 1;
        inDegree.set(dependent, newDegree);
        if (newDegree === 0) queue.push(dependent);
      }
    }

    if (layer.length > 0) {
      topology.push(layer);
      currentLayer++;
    }
  }

  if (processed !== allKeys.length) {
    throw new Error(
      `Cycle detected in cell dependency graph (${allKeys.length - processed} cells unreachable)`
    );
  }

  return { topology, index };
};

// ========================================================================
// Wave resolution — effective wave = max(declared, every input's effective
// wave). Stamps cel.wave as a side effect.
// ========================================================================

const buildWaves = (cels: CelMap, topology: Topology): Map<Key, number> => {
  const waveOfKey = new Map<Key, number>();

  for (const layer of topology) {
    for (const key of layer) {
      const cel = cels.get(key);
      if (!cel) continue;

      let effective = cel.wave ?? 0;

      if (cel.inputMap) {
        for (const keyOrKeys of Object.values(cel.inputMap)) {
          const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
          for (const k of keys) {
            const inputWave = waveOfKey.get(k) ?? 0;
            if (inputWave > effective) effective = inputWave;
          }
        }
      }

      waveOfKey.set(key, effective);
      cel.wave = effective;
    }
  }

  return waveOfKey;
};

// ========================================================================
// Downstream closure — for each key, the set of keys downstream of it
// (NOT including self).
// ========================================================================

const buildDownstreamClosure = (cels: CelMap, topology: Topology): DownstreamClosure => {
  const closure: DownstreamClosure = new Map();

  for (const key of cels.keys()) {
    closure.set(key, new Set());
  }

  for (let i = topology.length - 1; i >= 0; i--) {
    for (const key of topology[i]) {
      const cel = cels.get(key);
      if (!cel) continue;

      const mySet = closure.get(key)!;
      for (const childKey of cel.children ?? []) {
        if (!closure.has(childKey)) continue;
        mySet.add(childKey);
        for (const grandchild of closure.get(childKey)!) {
          mySet.add(grandchild);
        }
      }
    }
  }

  return closure;
};

// ========================================================================
// Downstream topology — per-key, wave-partitioned cascade.
// ========================================================================

const buildDownstreamTopology = (
  closure: DownstreamClosure,
  topologyIndex: TopologyIndex,
  waveOfKey: Map<Key, number>,
): DownstreamTopology => {
  const result: DownstreamTopology = new Map();

  for (const [key, downstream] of closure) {
    const allKeys: Set<Key> = new Set(downstream);
    allKeys.add(key);

    const byWave = new Map<number, Map<number, Key[]>>();
    for (const k of allKeys) {
      const layer = topologyIndex.get(k);
      if (layer === undefined) continue;
      const wave = waveOfKey.get(k) ?? 0;
      let waveBucket = byWave.get(wave);
      if (!waveBucket) {
        waveBucket = new Map();
        byWave.set(wave, waveBucket);
      }
      if (!waveBucket.has(layer)) waveBucket.set(layer, []);
      waveBucket.get(layer)!.push(k);
    }

    const waved: WavedCascade = new Map();
    const waves = Array.from(byWave.keys()).sort((a, b) => a - b);
    for (const w of waves) {
      const layers = byWave.get(w)!;
      const sortedLayers = Array.from(layers.keys()).sort((a, b) => a - b);
      waved.set(w, sortedLayers.map(l => layers.get(l)!));
    }
    result.set(key, waved);
  }

  return result;
};

// ========================================================================
// Dynamic (volatile) cell indexes.
// ========================================================================

const buildDynamicIndexes = (
  cels: CelMap,
  closure: DownstreamClosure,
  topologyIndex: TopologyIndex,
): { dynamicKeys: DynamicKeys; dynamicCascade: DynamicCascade } => {
  const dynamicKeys: DynamicKeys = new Set();

  for (const [key, cel] of cels) {
    if (cel.dynamic) dynamicKeys.add(key);
  }

  const allAffected = new Set<Key>();
  for (const key of dynamicKeys) {
    allAffected.add(key);
    const downstream = closure.get(key);
    if (downstream) {
      for (const k of downstream) allAffected.add(k);
    }
  }

  const byLayer = new Map<number, Key[]>();
  for (const k of allAffected) {
    const layer = topologyIndex.get(k);
    if (layer === undefined) continue;
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer)!.push(k);
  }

  const sortedLayers = Array.from(byLayer.keys()).sort((a, b) => a - b);
  const dynamicCascade: DynamicCascade = sortedLayers.map(l => byLayer.get(l)!);

  return { dynamicKeys, dynamicCascade };
};
