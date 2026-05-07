import type { Cel, Key, State } from "../types/index.js";

// ============================================================================
// precompute — derive the indexes runCycle and the input fns need,
// then write them into the locked precomputedStates cel. Internal:
// hydrate imports it directly. NOT registered in coreFns. Run again
// whenever the cel graph changes.
//
// Indexes:
//   • waveCascade — wave → topo-sorted lambda cel keys. Used by
//     runCycle (full cascade) and as the iteration order for any
//     filtered subset.
//   • downstream  — for each key, the closure of cels downstream
//     of it (children + grandchildren …). Used by set/batch to fire
//     only what the write affects.
//   • dynamicCascade — every cel marked `dynamic` plus their
//     downstream closures, unioned. Always included on every cycle so
//     volatile cels (clocks, randoms, externally-driven) refresh.
// ============================================================================

export const PRECOMPUTED_STATES_KEY = "precomputedStates" as const;

export interface PrecomputedIndexes {
  /** wave → ordered lambda cel keys to fire in that wave. */
  waveCascade: Map<number, Key[]>;
  /** key → set of cel keys downstream of it (excluding self). */
  downstream: Map<Key, Set<Key>>;
  /** Union of every dynamic cel + its downstream closure. */
  dynamicCascade: Set<Key>;
}

export const precompute = (state: State): void => {
  const cels = state.cels;

  const byWave = new Map<number, Key[]>();
  for (const cel of cels.values()) {
    if (!cel.l) continue;
    const wave = cel.wave ?? 0;
    let bucket = byWave.get(wave);
    if (!bucket) { bucket = []; byWave.set(wave, bucket); }
    bucket.push(cel.key);
  }
  const waveCascade = new Map<number, Key[]>();
  for (const [wave, members] of byWave) {
    waveCascade.set(wave, topoSort(members, cels));
  }

  const children = buildChildren(cels);
  const downstream = buildDownstream(cels, children);
  const dynamicCascade = buildDynamicCascade(cels, downstream);

  const target = cels.get(PRECOMPUTED_STATES_KEY);
  if (target) {
    target.v = { waveCascade, downstream, dynamicCascade } satisfies PrecomputedIndexes;
  }
};

// Reverse adjacency derived from inputMap: for each upstream cel,
// the set of cels that consume it as input.
const buildChildren = (cels: Map<Key, Cel>): Map<Key, Set<Key>> => {
  const children = new Map<Key, Set<Key>>();
  for (const cel of cels.values()) {
    if (!cel.inputMap) continue;
    for (const ref of Object.values(cel.inputMap)) {
      for (const upstream of Array.isArray(ref) ? ref : [ref]) {
        let s = children.get(upstream);
        if (!s) { s = new Set(); children.set(upstream, s); }
        s.add(cel.key);
      }
    }
  }
  return children;
};

// For every cel, collect the transitive closure of cels downstream.
// O(N · E) worst case — fine for small graphs; revisit if a sheet ever
// pushes much past a few thousand cels.
const buildDownstream = (
  cels: Map<Key, Cel>,
  children: Map<Key, Set<Key>>,
): Map<Key, Set<Key>> => {
  const downstream = new Map<Key, Set<Key>>();

  const collect = (key: Key, acc: Set<Key>): void => {
    const kids = children.get(key);
    if (!kids) return;
    for (const k of kids) {
      if (acc.has(k)) continue;
      acc.add(k);
      collect(k, acc);
    }
  };

  for (const key of cels.keys()) {
    const acc = new Set<Key>();
    collect(key, acc);
    downstream.set(key, acc);
  }
  return downstream;
};

const buildDynamicCascade = (
  cels: Map<Key, Cel>,
  downstream: Map<Key, Set<Key>>,
): Set<Key> => {
  const result = new Set<Key>();
  for (const [key, cel] of cels) {
    if (!cel.dynamic) continue;
    result.add(key);
    const ds = downstream.get(key);
    if (ds) for (const k of ds) result.add(k);
  }
  return result;
};

// Kahn's: order `members` so every in-set upstream comes before its
// dependants. Throws if a cycle is found.
const topoSort = (members: Key[], cels: Map<Key, Cel>): Key[] => {
  const memberSet = new Set(members);
  const upstreamOf = new Map<Key, Set<Key>>();
  for (const key of members) {
    const cel = cels.get(key)!;
    const ds = new Set<Key>();
    if (cel.inputMap) {
      for (const ref of Object.values(cel.inputMap)) {
        for (const k of Array.isArray(ref) ? ref : [ref]) {
          if (memberSet.has(k)) ds.add(k);
        }
      }
    }
    upstreamOf.set(key, ds);
  }

  const order: Key[] = [];
  const remaining = new Set(members);
  while (remaining.size > 0) {
    const ready: Key[] = [];
    for (const k of remaining) {
      let satisfied = true;
      for (const d of upstreamOf.get(k)!) {
        if (remaining.has(d)) { satisfied = false; break; }
      }
      if (satisfied) ready.push(k);
    }
    if (ready.length === 0) {
      throw new Error(`Dependency cycle in cel graph; remaining: ${[...remaining].join(", ")}`);
    }
    for (const k of ready) {
      order.push(k);
      remaining.delete(k);
    }
  }
  return order;
};
