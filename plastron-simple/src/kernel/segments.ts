import type { Key, State, 冊 } from "../types/index.js";

// ============================================================================
// Segment introspection helpers — getSegmentManifest, listSegments,
// findDependents. Registered as locked core fns so lambdas / host
// tooling can react to what's loaded without depending on the kernel
// module directly. Sync, side-effect-free, small.
// ============================================================================

/** Return the manifest for a loaded segment, or undefined. */
export const getSegmentManifest = (
  state: State,
  key: Key,
): 冊 | undefined => state.segments.get(key);

/** Return all loaded segment manifests, in load order
 *  (Map iteration is insertion-ordered in JS). */
export const listSegments = (state: State): 冊[] =>
  Array.from(state.segments.values());

/** Return the segments that declare segmentKey as a dependency. */
export const findDependents = (state: State, segmentKey: Key): Key[] => {
  const out: Key[] = [];
  for (const [k, m] of state.segments) {
    if (m.dependencies.includes(segmentKey)) out.push(k);
  }
  return out;
};

/** Topological order of the transitive dependents of `segmentKey`,
 *  leaves first. Used by flush(..., { cascade: true }) to know which
 *  dependents to flush before the target. */
export const topologicalDependentOrder = (
  segments: Map<Key, 冊>,
  segmentKey: Key,
): Key[] => {
  // Reverse adjacency: dep → list of dependents.
  const dependentsOf = new Map<Key, Key[]>();
  for (const [k, m] of segments) {
    for (const d of m.dependencies) {
      let bucket = dependentsOf.get(d);
      if (!bucket) { bucket = []; dependentsOf.set(d, bucket); }
      bucket.push(k);
    }
  }

  // BFS the transitive dependent set, then return in
  // dependents-first order via DFS post-order.
  const visited = new Set<Key>();
  const order: Key[] = [];
  const visit = (k: Key): void => {
    if (visited.has(k)) return;
    visited.add(k);
    for (const child of dependentsOf.get(k) ?? []) visit(child);
    if (k !== segmentKey) order.push(k);
  };
  visit(segmentKey);
  return order;
};
