// ============================================================================
// Generic topological helpers shared by the cascade builder
// (`precompute/precompute.ts`), segment-flush ordering (`segments.ts`), and
// the segment-classification machinery (boot kernel-set, hydration order,
// orphan detection).
//
// Both helpers are pure: no kernel coupling, no State knowledge. They
// operate on abstract node identifiers and adjacency functions. Consumers
// provide the closure that resolves upstreams (or reverse-adjacency) for
// their specific node kind.
//
// See docs/1-design/3-accepted/00-ontology/segment-classification.md
// "Shared topo helper" for the extraction rationale and design.
// ============================================================================

export interface TopoLevelsOptions<T> {
  /** When set, only treat upstream edges where the upstream is in
   *  this set; ignore others. The cascade per-wave grouping uses this
   *  to filter out upstreams outside the wave. Segment DAG walks
   *  typically omit it (all nodes are members). */
  memberSet?: ReadonlySet<T>;
  /** Error prefix when a cycle is detected. Default: "Dependency cycle". */
  cycleMessagePrefix?: string;
}

/** Kahn-style topological level grouping. Returns arrays of nodes where
 *  every node at level N has all its upstreams resolved by earlier
 *  levels. Throws on cycles with the unresolved nodes attached to the
 *  error as `.cycle: T[]`.
 *
 *  Suitable for cel-wave construction (cascade), segment-DAG walks
 *  (boot kernel-set, hydration order), and any other DAG-leveling
 *  problem. */
export const topoLevels = <T>(
  nodes: Iterable<T>,
  upstreamsOf: (node: T) => Iterable<T>,
  options?: TopoLevelsOptions<T>,
): T[][] => {
  const memberSet = options?.memberSet;
  const prefix = options?.cycleMessagePrefix ?? "Dependency cycle";
  const remaining = new Set<T>(nodes);
  const upstream = new Map<T, Set<T>>();
  for (const k of remaining) {
    const deps = new Set<T>();
    for (const u of upstreamsOf(k)) {
      if (memberSet === undefined || memberSet.has(u)) deps.add(u);
    }
    upstream.set(k, deps);
  }
  const levels: T[][] = [];
  while (remaining.size > 0) {
    const ready: T[] = [];
    for (const k of remaining) {
      let satisfied = true;
      for (const d of upstream.get(k)!) {
        if (remaining.has(d)) { satisfied = false; break; }
      }
      if (satisfied) ready.push(k);
    }
    if (ready.length === 0) {
      const cycle = [...remaining];
      const err = new Error(
        `${prefix}; remaining: ${cycle.map(String).join(", ")}`,
      ) as Error & { cycle: T[] };
      err.cycle = cycle;
      throw err;
    }
    levels.push(ready);
    for (const k of ready) remaining.delete(k);
  }
  return levels;
};

/** DFS post-order traversal — dependents-first ordering reachable from
 *  `root` via the supplied reverse-adjacency map (node → set of nodes
 *  that depend on it). The root itself is excluded from the returned
 *  list. Used by flush's `cascade: true` to tear down dependents
 *  before the target. */
export const dependentOrderFrom = <T>(
  root: T,
  reverseAdjacency: ReadonlyMap<T, Iterable<T>>,
): T[] => {
  const visited = new Set<T>();
  const order: T[] = [];
  const visit = (k: T): void => {
    if (visited.has(k)) return;
    visited.add(k);
    for (const child of reverseAdjacency.get(k) ?? []) visit(child);
    if (k !== root) order.push(k);
  };
  visit(root);
  return order;
};

/** Forward-transitive closure from a set of roots. Returns every node
 *  reachable by following the `downstreamsOf` function (which yields
 *  the direct dependencies of a node — semantics flexible per caller).
 *  Used for the boot kernel-set computation: closure(role=kernel
 *  segments, m => m.dependencies). */
export const transitiveClosure = <T>(
  roots: Iterable<T>,
  downstreamsOf: (node: T) => Iterable<T>,
): Set<T> => {
  const out = new Set<T>();
  const stack: T[] = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (out.has(node)) continue;
    out.add(node);
    for (const d of downstreamsOf(node)) {
      if (!out.has(d)) stack.push(d);
    }
  }
  return out;
};
