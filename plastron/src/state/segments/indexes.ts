import type { Cel } from "../types/cel.js";
import type {
  TagIndex, DownstreamTopology, DynamicCascade, DynamicKeys,
  SegmentCelsIndex,
} from "./types/indexes.js";

// ========================================================================
// Segment "indexes" — derived graph data, rebuilt on every hydrate call
// and pruned on flush. Consumers (setter, cascade-merge, runCycle) read
// directly from these cel values instead of a threaded index parameter.
// ========================================================================

const indexTagIndex: Cel = {
  key: "tagIndex",
  name: "Tag Index",
  description: "Hydrate-populated. { tag: Key[] } — inverse lookup from each tag to the cels that carry it.",
  v: {} satisfies TagIndex,
  children: [],
  segment: "indexes",
};

const indexDownstreamTopology: Cel = {
  key: "downstreamTopology",
  name: "Downstream Topology",
  description: "Precompute-populated. Map<Key, WavedCascade> — per-key cascade to fire on write.",
  v: new Map() satisfies DownstreamTopology,
  children: [],
  segment: "indexes",
};

const indexDynamicCascade: Cel = {
  key: "dynamicCascade",
  name: "Dynamic Cascade",
  description: "Precompute-populated. Layered cascade of all dynamic cels + their downstreams.",
  v: [] satisfies DynamicCascade,
  children: [],
  segment: "indexes",
};

const indexDynamicKeys: Cel = {
  key: "dynamicKeys",
  name: "Dynamic Keys",
  description: "Precompute-populated. Set<Key> — cels carrying dynamic: true.",
  v: new Set() satisfies DynamicKeys,
  children: [],
  segment: "indexes",
};

const indexFlushIndex: Cel = {
  key: "flushIndex",
  name: "Flush Index",
  description: "Hydrate-populated. Map<segmentKey, Set<celKey>> — cels belonging to each segment, consulted during flush.",
  v: new Map() satisfies SegmentCelsIndex,
  children: [],
  segment: "indexes",
};

/** All cels in segment "indexes". */
export const indexCells: Cel[] = [
  indexTagIndex,
  indexDownstreamTopology,
  indexDynamicCascade,
  indexDynamicKeys,
  indexFlushIndex,
];
