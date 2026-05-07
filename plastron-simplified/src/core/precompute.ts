import type { Cel, Key, State } from "../types.js";
import { PRECOMPUTED_STATES_KEY } from "../initial.js";

// ============================================================================
// precompute — derive the indexes runCycle needs and write them into
// the locked precomputedStates cel. Internal: hydrate imports it
// directly. NOT registered in coreFns. Run again whenever the cel
// graph changes.
//
// Today the index is a single waveCascade: wave number → topologically
// ordered list of lambda cel keys. Add more entries here as the kernel
// grows; runCycle reads them through the same cel.
// ============================================================================

export interface PrecomputedIndexes {
  /** wave → ordered lambda cel keys to fire in that wave. */
  waveCascade: Map<number, Key[]>;
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

  const target = cels.get(PRECOMPUTED_STATES_KEY);
  if (target) target.v = { waveCascade } satisfies PrecomputedIndexes;
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
