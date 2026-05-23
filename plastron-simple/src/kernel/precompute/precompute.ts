import type {
  Cel, Channel, ChannelCel, ChannelEnqueue, FireableCel, Key, State,
} from "../../types/index.js";
import { isFireable, kindOf } from "../../types/index.js";
import { resolveSchemas } from "../lifecycle/hydrate/schema.js";
import { resolveFn } from "../resolve-fn.js";
import { precomputeOptional } from "./precomputeOptional.js";
import { appendError, makeCelError } from "../../甲骨坑/cel-error.js";

export const PRECOMPUTED_STATES_KEY = "precomputedStates" as const;

export interface PrecomputedIndexes {
  waveCascade: Map<number, Key[][]>;
  sortedWaves: number[];
  /** Same shape as waveCascade but with each level partitioned by
   *  cel kind (see kindOf in types/cels.ts). v1 doesn't change dispatch
   *  — runCycle still walks waveCascade and fires cels inline on the
   *  main thread regardless of kind. The kind partition exists so the
   *  per-kind worker dispatch (WASM-DOMAIN.md § 5) can plug into the
   *  precompute side without moving any of it: when "py" arrives,
   *  the runCycle reads `waveCascadeByKind.get(W)[L].get("py")` and
   *  posts that batch to the py worker as a single round trip.
   *  Diagnostics already use it to count cross-kind cells per wave. */
  waveCascadeByKind: Map<number, Map<Key, Key[]>[]>;
  children: Map<Key, Set<Key>>;
  downstream: Map<Key, Set<Key>>;
  dynamicCascade: Set<Key>;
  /** Every ChannelCel in state.cels, keyed by its cel.metadata.key.
   *  Built at precompute; flushChannels and the enqueueChannels
   *  fallback path read this instead of a separate channelRegistry. */
  channels: Map<Key, ChannelCel>;
  /** Inverse of metadata.schema: schemaCelKey → set of cel keys whose
   *  metadata.schema points at it. When a SchemaCel's v changes, every
   *  cel in the set needs to re-validate. */
  schemaUsage: Map<Key, Set<Key>>;
  /** Inverse of "this formula/lambda references that lambda": lambdaCelKey
   *  → set of cel keys whose body calls it. Built conservatively from
   *  metadata.inputMap entries that resolve to a LambdaCel; the formula
   *  compiler can later populate this directly when it parses fn-head
   *  references that don't appear in inputMap. */
  lambdaUsage: Map<Key, Set<Key>>;
}

/** Build a fresh, empty PrecomputedIndexes. Used by the kernel-internal
 *  seed for the boot-time precomputedStates cel (JSON can't carry Maps
 *  or a Set), and available to host code that needs to rebuild after
 *  a reset. Lives here rather than index.ts to avoid a circular import
 *  from kernel-internal back through createInitialState. */
export const buildPrecomputedIndexes = (): PrecomputedIndexes => ({
  waveCascade:       new Map(),
  sortedWaves:       [],
  waveCascadeByKind: new Map(),
  children:          new Map(),
  downstream:        new Map(),
  dynamicCascade:    new Set(),
  channels:          new Map(),
  schemaUsage:       new Map(),
  lambdaUsage:       new Map(),
});

// Build the live Channel for a ChannelCel from its DehydratedChannel
// descriptor. Internal queue + resolveFn lookup for drain/dispose so
// the cel registry stays the single source of truth for runtime fns.
const buildChannel = (cel: ChannelCel, state: State): Channel => {
  const queue: ChannelEnqueue[] = [];
  const drainKey = cel.v.drain;
  const disposeKey = cel.v.dispose;
  return {
    enqueue: (args) => { queue.push(args); },
    hasPending: () => queue.length > 0,
    drain: () => {
      const fn = resolveFn(state, drainKey);
      if (!fn) { queue.length = 0; return; }
      const items = queue.splice(0);
      const r = fn(items, state);
      if (r instanceof Promise) return r as Promise<void>;
      return;
    },
    dispose: () => {
      if (!disposeKey) return;
      const fn = resolveFn(state, disposeKey);
      if (fn) fn(state);
    },
  };
};

export const precompute = (state: State): void => {
  const cels = state.cels;

  const byWave = new Map<number, Key[]>();
  for (const cel of cels.values()) {
    if (!isFireable(cel)) continue;
    if (!cel._fn) continue;
    // Cascade membership requires an observable signal — either an
    // inputMap declaring upstream deps, or `dynamic` (refresh every
    // cycle). Cels with neither are dispatch surfaces (core fn cels,
    // registerLambda-created lambdas) whose _fn is called by other
    // code with its own calling convention, not by the cascade.
    if (!cel.metadata.inputMap && !cel.dynamic) continue;
    const wave = cel.wave ?? 0;
    let bucket = byWave.get(wave);
    if (!bucket) { bucket = []; byWave.set(wave, bucket); }
    bucket.push(cel.metadata.key);
  }
  const waveCascade = new Map<number, Key[][]>();
  for (const [wave, members] of byWave) {
    try {
      waveCascade.set(wave, topoLevels(members, cels));
    } catch (e) {
      // Append-before-rethrow so the host can enumerate the cycle via
      // the errors log even though precompute itself still throws (the
      // graph is malformed; the cascade can't run). topoLevels stashes
      // the participating cel keys on err.cycle for this purpose.
      const cycle = (e as { cycle?: Key[] }).cycle ?? [];
      appendError(state, makeCelError(cycle, "CycleError", e));
      throw e;
    }
  }
  const sortedWaves = [...waveCascade.keys()].sort((a, b) => a - b);

  // Partition each level by kind. Cels carrying their callable on the
  // main thread (FormulaCels, JS lambdas) land in the "js" bucket;
  // wat lambdas in "wat", etc. The map preserves insertion order so
  // dispatch iteration is stable. Empty buckets aren't created — a
  // level with no py cels simply has no "py" key. Read sites should
  // tolerate missing kinds.
  const waveCascadeByKind = new Map<number, Map<Key, Key[]>[]>();
  for (const [wave, levels] of waveCascade) {
    const byKind: Map<Key, Key[]>[] = levels.map((level) => {
      const partition = new Map<Key, Key[]>();
      for (const key of level) {
        const cel = cels.get(key);
        if (!cel || !isFireable(cel)) continue;
        const k = kindOf(cel as FireableCel);
        let bucket = partition.get(k);
        if (!bucket) { bucket = []; partition.set(k, bucket); }
        bucket.push(key);
      }
      return partition;
    });
    waveCascadeByKind.set(wave, byKind);
  }

  const children = buildChildren(cels);
  const dynamicCascade = buildDynamicCascade(cels, children);
  const schemaUsage = buildSchemaUsage(cels);
  const lambdaUsage = buildLambdaUsage(cels);

  // Channels — gather ChannelCels and (re)build each one's live
  // Channel. cel._channel always points at a fresh handler whose
  // closure captures the current cel-registry lookups for drain/dispose.
  const channels = new Map<Key, ChannelCel>();
  for (const cel of cels.values()) {
    if (cel.celType !== "ChannelCel") continue;
    const ccel = cel as ChannelCel;
    ccel._channel = buildChannel(ccel, state);
    channels.set(ccel.metadata.key, ccel);
  }

  // Re-resolve cel.schema caches. SchemaCel.v swaps need every cel
  // pointing at that key to pick up the new Schema struct; cheaper to
  // just walk all cels here than to thread a targeted refresh.
  resolveSchemas(state);

  // Invalidate per-cel runtime caches on fireable cels.
  for (const cel of cels.values()) {
    if (!isFireable(cel)) continue;
    if (cel._inputEntries    !== undefined) cel._inputEntries    = undefined;
    if (cel._channelHandlers !== undefined) cel._channelHandlers = undefined;
    if (cel._evaluate        !== undefined) cel._evaluate        = undefined;
  }

  state.precomputeGeneration = (state.precomputeGeneration ?? 0) + 1;

  const target = cels.get(PRECOMPUTED_STATES_KEY);
  if (target) {
    target.v = {
      waveCascade,
      sortedWaves,
      waveCascadeByKind,
      children,
      downstream: new Map(),
      dynamicCascade,
      channels,
      schemaUsage,
      lambdaUsage,
    } satisfies PrecomputedIndexes;
  }

  void precomputeOptional(state);
};

const buildChildren = (cels: Map<Key, Cel>): Map<Key, Set<Key>> => {
  const children = new Map<Key, Set<Key>>();
  for (const cel of cels.values()) {
    if (!isFireable(cel)) continue;
    const inputMap = cel.metadata.inputMap;
    if (!inputMap) continue;
    for (const ref of Object.values(inputMap)) {
      for (const upstream of Array.isArray(ref) ? ref : [ref]) {
        let s = children.get(upstream);
        if (!s) { s = new Set(); children.set(upstream, s); }
        s.add(cel.metadata.key);
      }
    }
  }
  return children;
};

export const bfsDownstream = (
  start: Key,
  children: Map<Key, Set<Key>>,
): Set<Key> => {
  const acc = new Set<Key>();
  const queue: Key[] = [];
  const seed = children.get(start);
  if (!seed) return acc;
  for (const c of seed) { acc.add(c); queue.push(c); }
  while (queue.length > 0) {
    const k = queue.pop()!;
    const kids = children.get(k);
    if (!kids) continue;
    for (const c of kids) {
      if (!acc.has(c)) { acc.add(c); queue.push(c); }
    }
  }
  return acc;
};

const isLambdaCelType = (t: Cel["celType"]): boolean =>
  t === "EditableLambdaCel" || t === "LockedLambdaCel";

const buildSchemaUsage = (cels: Map<Key, Cel>): Map<Key, Set<Key>> => {
  const usage = new Map<Key, Set<Key>>();
  for (const cel of cels.values()) {
    const schemaKey = cel.metadata.schema;
    if (!schemaKey) continue;
    let s = usage.get(schemaKey);
    if (!s) { s = new Set(); usage.set(schemaKey, s); }
    s.add(cel.metadata.key);
  }
  return usage;
};

// Conservative pass: walk inputMap of every fireable cel and record
// any upstream that resolves to a LambdaCel. The formula compiler can
// extend this later with fn-head references it parses out of S-exprs
// that don't show up in inputMap.
const buildLambdaUsage = (cels: Map<Key, Cel>): Map<Key, Set<Key>> => {
  const usage = new Map<Key, Set<Key>>();
  for (const cel of cels.values()) {
    if (!isFireable(cel)) continue;
    const inputMap = cel.metadata.inputMap;
    if (!inputMap) continue;
    for (const ref of Object.values(inputMap)) {
      for (const k of Array.isArray(ref) ? ref : [ref]) {
        const upstream = cels.get(k);
        if (!upstream || !isLambdaCelType(upstream.celType)) continue;
        let s = usage.get(k);
        if (!s) { s = new Set(); usage.set(k, s); }
        s.add(cel.metadata.key);
      }
    }
  }
  return usage;
};

const buildDynamicCascade = (
  cels: Map<Key, Cel>,
  children: Map<Key, Set<Key>>,
): Set<Key> => {
  const result = new Set<Key>();
  for (const [key, cel] of cels) {
    if (!isFireable(cel)) continue;
    if (!cel.dynamic) continue;
    result.add(key);
    const ds = bfsDownstream(key, children);
    for (const k of ds) result.add(k);
  }
  return result;
};

const topoLevels = (members: Key[], cels: Map<Key, Cel>): Key[][] => {
  const memberSet = new Set(members);
  const upstreamOf = new Map<Key, Set<Key>>();
  for (const key of members) {
    const cel = cels.get(key)!;
    const ds = new Set<Key>();
    if (isFireable(cel)) {
      const inputMap = cel.metadata.inputMap;
      if (inputMap) {
        for (const ref of Object.values(inputMap)) {
          for (const k of Array.isArray(ref) ? ref : [ref]) {
            if (memberSet.has(k)) ds.add(k);
          }
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
      const cycle = [...remaining];
      const err = new Error(`Dependency cycle in cel graph; remaining: ${cycle.join(", ")}`) as Error & { cycle: Key[] };
      err.cycle = cycle;
      throw err;
    }
    levels.push(ready);
    for (const k of ready) remaining.delete(k);
  }
  return levels;
};
