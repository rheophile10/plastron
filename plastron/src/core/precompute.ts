import type { Cel, Key, ResolvedInputs, State } from "../types/index.js";

// ============================================================================
// precompute — derive the indexes runCycle and the input fns need,
// then write them into the locked precomputedStates cel. Internal:
// hydrate imports it directly. NOT registered in coreFns. Run again
// whenever the cel graph changes (hydrate end + flush end).
//
// Indexes:
//   • waveCascade — wave → ordered levels of mutually-independent
//     lambda cel keys. Each level is a Kahn frontier: every cel in
//     level N has all of its in-wave upstream deps in levels < N.
//     Cels within a single level have no transitive dep edge between
//     them, so runCascade fires them concurrently (Promise.all over
//     async fns; sync fns just complete inline). Used by runCycle
//     (full cascade) and by the input fns for filtered subsets.
//   • sortedWaves — waveCascade keys sorted ascending. Cached so
//     runCascade doesn't re-spread + re-sort on every cycle.
//   • downstream  — for each key, the closure of cels downstream
//     of it (children + grandchildren …). Used by set/batch to fire
//     only what the write affects.
//   • dynamicCascade — every cel marked `dynamic` plus their
//     downstream closures, unioned. Always included on every cycle so
//     volatile cels (clocks, randoms, externally-driven) refresh.
//
// In addition to the indexes, precompute materializes per-cel runtime
// caches:
//   • cel._inputEntries    — inputMap resolved to direct cel refs
//   • cel._channelHandlers — cel.channel resolved to live handlers
//   • cel._evaluate        — compiler-supplied closure, captures cels
//                            directly so fireCel skips input-object
//                            construction. Built only when the cel's
//                            compiler attached a buildEvaluate hook
//                            on its CompiledEnvelope.
// These run last (after the index work) so they pick up the final cel
// graph and the current state.channelRegistry.
// ============================================================================

export const PRECOMPUTED_STATES_KEY = "precomputedStates" as const;

export interface PrecomputedIndexes {
  /** wave → list of levels; each level is a list of cel keys that
   *  share no in-wave upstream-downstream edge with each other. */
  waveCascade: Map<number, Key[][]>;
  /** waveCascade.keys() sorted ascending. Cached for runCascade. */
  sortedWaves: number[];
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
  const waveCascade = new Map<number, Key[][]>();
  for (const [wave, members] of byWave) {
    waveCascade.set(wave, topoLevels(members, cels));
  }
  const sortedWaves = [...waveCascade.keys()].sort((a, b) => a - b);

  const children = buildChildren(cels);
  const downstream = buildDownstream(cels, children);
  const dynamicCascade = buildDynamicCascade(cels, downstream);

  resolveInputEntries(cels);
  resolveChannelHandlers(state);
  resolveEvaluate(cels);

  const target = cels.get(PRECOMPUTED_STATES_KEY);
  if (target) {
    target.v = {
      waveCascade, sortedWaves, downstream, dynamicCascade,
    } satisfies PrecomputedIndexes;
  }
};

// For every cel with an inputMap, resolve each declared key to its
// live Cel object. The hot path then iterates this directly instead
// of calling Map.get on every input on every fire. Slot order matches
// Object.entries(inputMap). Missing upstreams resolve to undefined,
// preserving the prior `state.cels.get(ref)?.v` behavior.
const resolveInputEntries = (cels: Map<Key, Cel>): void => {
  for (const cel of cels.values()) {
    if (!cel.inputMap) {
      cel._inputEntries = undefined;
      continue;
    }
    const entries: Array<[string, Cel | undefined | Array<Cel | undefined>]> = [];
    for (const [name, ref] of Object.entries(cel.inputMap)) {
      if (Array.isArray(ref)) {
        entries.push([name, ref.map((k) => cels.get(k))]);
      } else {
        entries.push([name, cels.get(ref)]);
      }
    }
    cel._inputEntries = entries;
  }
};

// For every cel with a channel binding, resolve to live handler refs
// from state.channelRegistry. Channels not registered at precompute
// time are silently dropped (host should register before hydrating
// cels that reference them). Re-runs of precompute pick up changes.
const resolveChannelHandlers = (state: State): void => {
  for (const cel of state.cels.values()) {
    if (!cel.channel) {
      cel._channelHandlers = undefined;
      continue;
    }
    const keys = Array.isArray(cel.channel) ? cel.channel : [cel.channel];
    const handlers = [];
    for (const k of keys) {
      const h = state.channelRegistry.get(k);
      if (h) handlers.push(h);
    }
    cel._channelHandlers = handlers.length > 0 ? handlers : undefined;
  }
};

// For every cel whose compiler supplied a buildEvaluate hook (stored
// on cel._buildEvaluate at compile time), construct a per-cel
// evaluator closure that captures live cel refs directly. fireCel
// uses cel._evaluate when set and skips input-object construction.
// Cels without _buildEvaluate, or whose inputMap didn't resolve to
// any entries, leave _evaluate undefined — fireCel falls through to
// the standard gather-and-call path.
const resolveEvaluate = (cels: Map<Key, Cel>): void => {
  for (const cel of cels.values()) {
    if (!cel._buildEvaluate || !cel._inputEntries) {
      cel._evaluate = undefined;
      continue;
    }
    const inputs: ResolvedInputs = {};
    for (const [name, cs] of cel._inputEntries) {
      inputs[name] = cs;
    }
    cel._evaluate = cel._buildEvaluate(inputs);
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

// Kahn's, level-aware: order `members` into a sequence of levels so
// every cel's in-set upstream is in a strictly earlier level. Cels
// within a level have no transitive dep edge between them — they can
// fire concurrently. Throws if a cycle is found.
const topoLevels = (members: Key[], cels: Map<Key, Cel>): Key[][] => {
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

  const levels: Key[][] = [];
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
    levels.push(ready);
    for (const k of ready) remaining.delete(k);
  }
  return levels;
};
