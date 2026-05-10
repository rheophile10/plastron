import type {
  Cel, ChannelHandler, Key, ResolvedInputs, State,
} from "../types/index.js";

// ============================================================================
// precompute — derive the indexes runCycle and the input fns need,
// then write them into the locked precomputedStates cel. Internal:
// hydrate / setCel / setCelBatch / flush call it directly. NOT
// registered in coreFns.
//
// Two-phase model:
//
//   • Essential pass (sync, in `precompute(state)`):
//         Wave grouping → topoLevels → waveCascade
//         sortedWaves
//         buildChildren → buildDownstream → downstream
//         buildDynamicCascade → dynamicCascade
//         Write the precomputedStates cel
//         Invalidate per-cel runtime caches (_inputEntries,
//           _channelHandlers, _evaluate) so fireCel falls through to
//           slow paths until the optional pass repopulates them.
//         Bump state.precomputeGeneration.
//         Schedule the optional pass (fire-and-forget; never throws).
//     The cascade can fire correctly the moment precompute returns —
//     correctness comes from the indexes + fallback paths in fireCel,
//     not from the runtime caches.
//
//   • Optional pass (async, in `precomputeOptional(state)`):
//         For each cel (chunked at OPTIONAL_CHUNK_SIZE = 256, with a
//         microtask yield between chunks):
//           resolve cel._inputEntries from cel.inputMap + state.cels
//           resolve cel._channelHandlers from cel.channel + state.channelRegistry
//           resolve cel._evaluate via cel._buildEvaluate (await if Promise)
//         Captures state.precomputeGeneration at start and re-checks
//         before each commit; aborts cleanly if a newer essential
//         pass has bumped the token. Per-cel errors are caught and
//         logged; never throws.
//
//   • Indexes:
//       waveCascade — wave → ordered levels of mutually-independent
//         lambda cel keys. Each level is a Kahn frontier; cels in a
//         level have no transitive dep edge between them, so runCascade
//         fires them concurrently (Promise.all over async fns; sync
//         fns just complete inline).
//       sortedWaves — waveCascade keys sorted ascending. Cached so
//         runCascade doesn't re-spread + re-sort on every cycle.
//       downstream — for each key, the closure of cels downstream
//         (children + grandchildren …). Used by set/batch to scope
//         the affected set.
//       dynamicCascade — every cel marked `dynamic` plus their
//         downstream closures, unioned. Always included on every cycle
//         so volatile cels (clocks, randoms) refresh.
// ============================================================================

export const PRECOMPUTED_STATES_KEY = "precomputedStates" as const;

/** Chunk size for the optional pass — bound the synchronous run before
 *  yielding to the event loop. 256 cels per chunk is small enough that
 *  even a 100k-cel graph yields ~400 times (~6 ms per yield window),
 *  large enough that the microtask overhead is negligible relative to
 *  the per-cel resolution work. */
const OPTIONAL_CHUNK_SIZE = 256;

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

// ── Essential pass ──────────────────────────────────────────────────────────

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

  // Invalidate per-cel runtime caches so the cascade falls back to
  // slow paths until the optional pass repopulates. Without this,
  // a topology change could leave stale closures pointing at removed
  // or reshaped cels.
  for (const cel of cels.values()) {
    cel._inputEntries = undefined;
    cel._channelHandlers = undefined;
    cel._evaluate = undefined;
  }

  // Bump the generation BEFORE scheduling — precomputeOptional captures
  // it at start, so the new pass sees the new value, and any in-flight
  // pass from a prior precompute call sees the bumped value and aborts.
  state.precomputeGeneration = (state.precomputeGeneration ?? 0) + 1;

  const target = cels.get(PRECOMPUTED_STATES_KEY);
  if (target) {
    target.v = {
      waveCascade, sortedWaves, downstream, dynamicCascade,
    } satisfies PrecomputedIndexes;
  }

  // Schedule the optional pass. Fire-and-forget — precomputeOptional
  // catches its own errors so the Promise always resolves.
  void precomputeOptional(state);
};

// ── Optional pass ───────────────────────────────────────────────────────────

/** Async, chunked, cancellation-aware repopulation of per-cel runtime
 *  caches. Auto-scheduled by `precompute`; can also be awaited
 *  directly (e.g. by tests) to ensure caches are populated before
 *  inspecting performance characteristics. Idempotent — calling it
 *  multiple times against the same generation produces the same
 *  result; redundant passes just do duplicate work. */
export const precomputeOptional = async (state: State): Promise<void> => {
  const myGen = state.precomputeGeneration;
  const cels = state.cels;
  // Snapshot the cel list at start. Cels added by another concurrent
  // mutation will only be picked up by a subsequent essential pass
  // (which bumps the token; this run aborts).
  const allCels = [...cels.values()];

  for (let i = 0; i < allCels.length; i += OPTIONAL_CHUNK_SIZE) {
    if (state.precomputeGeneration !== myGen) return;

    const end = Math.min(i + OPTIONAL_CHUNK_SIZE, allCels.length);
    for (let j = i; j < end; j++) {
      if (state.precomputeGeneration !== myGen) return;
      const cel = allCels[j];

      try {
        // Resolve _inputEntries first — _evaluate's buildEvaluate
        // consumes it via the ResolvedInputs map below.
        if (cel.inputMap) {
          const entries: Array<[string, Cel | undefined | Array<Cel | undefined>]> = [];
          for (const [name, ref] of Object.entries(cel.inputMap)) {
            if (Array.isArray(ref)) {
              entries.push([name, ref.map((k) => cels.get(k))]);
            } else {
              entries.push([name, cels.get(ref)]);
            }
          }
          if (state.precomputeGeneration !== myGen) return;
          cel._inputEntries = entries;
        }

        // Resolve _channelHandlers from cel.channel + the live registry.
        if (cel.channel) {
          const keys = Array.isArray(cel.channel) ? cel.channel : [cel.channel];
          const handlers: ChannelHandler[] = [];
          for (const k of keys) {
            const h = state.channelRegistry.get(k);
            if (h) handlers.push(h);
          }
          if (state.precomputeGeneration !== myGen) return;
          cel._channelHandlers = handlers.length > 0 ? handlers : undefined;
        }

        // Resolve _evaluate via the compiler-supplied buildEvaluate
        // hook. Sync return → store directly. Promise return → await
        // (the only place the optional pass can yield mid-cel) and
        // re-check the generation token before storing.
        if (cel._buildEvaluate && cel._inputEntries) {
          const inputs: ResolvedInputs = {};
          for (const [name, cs] of cel._inputEntries) {
            inputs[name] = cs;
          }
          const result = cel._buildEvaluate(inputs);
          if (result instanceof Promise) {
            const resolved = await result;
            if (state.precomputeGeneration !== myGen) return;
            cel._evaluate = resolved;
          } else {
            cel._evaluate = result;
          }
        }
      } catch {
        // Per-cel errors don't sink the whole pass — clear cel._evaluate
        // so fireCel uses the slow path instead of running a half-
        // resolved closure. Errors are swallowed to keep the kernel
        // environment-agnostic (no console import); hosts that want
        // visibility can detect a stuck cel by observing that
        // cel._evaluate stayed undefined after precomputeOptional
        // resolved.
        cel._evaluate = undefined;
      }
    }

    // Yield to the event loop between chunks so the cascade, paint,
    // input handling, and any other awaiting work can interleave.
    // `await Promise.resolve()` is the kernel-portable equivalent of
    // queueMicrotask — same timing (next microtask), no dom/node lib.
    if (end < allCels.length) {
      if (state.precomputeGeneration !== myGen) return;
      await Promise.resolve();
    }
  }
};

// ── Index helpers ───────────────────────────────────────────────────────────

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
