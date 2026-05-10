// ============================================================================
// perf — opt-in performance tracking. All hooks are gated by
// `state.cels.get(CONFIG_PERFORMANCE).v.enabled`. When disabled (the
// default), every consumer must read at most one Map.get + one
// property and short-circuit. Hot-path callers are expected to lift
// the read into a local once per cycle.
//
// Cel layout:
//
//   • config_performance       segment "config"  — single bool +
//                              sub-flags. Survives dehydrate; `enabled`
//                              resets to false on hydrate of a
//                              dehydrated project.
//   • config_environment       segment "config"  — host-managed
//                              project-level env profile. Round-trips
//                              fully. Mutated by core fns
//                              (setFeatureFlag, setEnvironmentTag,
//                              syncSegmentsToConfig, freezeRuntimeProfile).
//   • stats_precompute         segment "stats"   — graph-level snapshot
//   • stats_cycles             segment "stats"   — last-cycle snapshot
//   • stats_functions          segment "stats"   — cumulative per-fn
//   • stats_channels           segment "stats"   — cumulative per-channel
//   • stats_environment        segment "stats"   — runtime capability
//                              snapshot. Filtered from dehydrate.
//
// All `stats_*` cels are dynamic so downstream observers re-fire each
// cycle. Stats writes bypass setCel — the kernel mutates `cel.v`
// directly to avoid re-entering the cycle.
// ============================================================================

import { z } from "zod";
import type {
  Cel, ChannelHandler, ChannelKey, Key, LambdaKey, State,
} from "../types/index.js";
import { estimateBytes } from "./perf-bytes.js";
import { REF_CEL_BYTES } from "./refs.js";

// ── Cel keys ────────────────────────────────────────────────────────────────

export const CONFIG_PERFORMANCE = "config_performance" as const;
export const CONFIG_ENVIRONMENT = "config_environment" as const;
export const STATS_PRECOMPUTE   = "stats_precompute" as const;
export const STATS_CYCLES       = "stats_cycles" as const;
export const STATS_FUNCTIONS    = "stats_functions" as const;
export const STATS_CHANNELS     = "stats_channels" as const;
export const STATS_ENVIRONMENT  = "stats_environment" as const;

export const STATS_SEGMENT  = "stats" as const;
export const CONFIG_SEGMENT = "config" as const;

// ── Config shape ────────────────────────────────────────────────────────────

export interface PerfConfig {
  enabled: boolean;
  trackPrecompute: boolean;
  trackCycles: boolean;
  trackFunctions: boolean;
  trackChannels: boolean;
  trackMemory: boolean;
  /** Track every Nth cycle. 1 = every cycle. */
  sampleRate: number;
  /** Per-cel detail recorded into stats_cycles.watchedCelTimings. */
  watchCels: Key[];
  /** When true, stats_precompute carries a per-cel array. Default
   *  false — on a 1M-cel graph the array dwarfs everything else. */
  includeCelDetail: boolean;
  /** Pass-through bag for host-defined extensions. */
  [k: string]: unknown;
}

export const DEFAULT_PERF_CONFIG: PerfConfig = {
  enabled: false,
  trackPrecompute: true,
  trackCycles: true,
  trackFunctions: true,
  trackChannels: true,
  trackMemory: true,
  sampleRate: 1,
  watchCels: [],
  includeCelDetail: false,
};

/** Zod schema for `config_performance.v`. Bound to the cel via
 *  `cel.schema` in createInitialState; surfaced for hosts that want to
 *  validate before injecting (`PERF_CONFIG_SCHEMA.parse(candidate)`).
 *  `.passthrough()` deliberately preserves host-defined extension flags
 *  — only the shape of the known fields is enforced. */
export const PERF_CONFIG_SCHEMA = z.object({
  enabled: z.boolean(),
  trackPrecompute: z.boolean(),
  trackCycles: z.boolean(),
  trackFunctions: z.boolean(),
  trackChannels: z.boolean(),
  trackMemory: z.boolean(),
  sampleRate: z.number(),
  watchCels: z.array(z.string()),
  includeCelDetail: z.boolean(),
}).passthrough();

export const PERF_CONFIG_SCHEMA_KEY = "config_performance" as const;

// ── High-res timer ──────────────────────────────────────────────────────────

/** Nanoseconds since some monotonic epoch. `performance.now()` returns
 *  ms with sub-μs resolution; we multiply and `| 0` to keep integers
 *  and avoid float drift across long runs. Falls back to Date.now() *
 *  1e6 when `performance` isn't on globalThis. */
export const nowNs: () => number = (() => {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf && typeof perf.now === "function") {
    return () => (perf.now!() * 1_000_000) | 0;
  }
  return () => (Date.now() * 1_000_000) | 0;
})();

// ── Read the live config (cheap; lifted into a local on the hot path) ──────

export const readPerfConfig = (state: State): PerfConfig | undefined => {
  const cel = state.cels.get(CONFIG_PERFORMANCE);
  return cel?.v as PerfConfig | undefined;
};

/** Cycle-entry decision: do we sample this cycle?
 *
 *  Returns the resolved config (so downstream code can read sub-flags
 *  without re-reading the cel) AND a boolean indicating whether the
 *  cycle is a sampling hit. cycleN is only bumped when tracking is
 *  enabled — the disabled path avoids touching state.perfScratch
 *  entirely so the hot path stays free.
 *
 *  Disabled-path cost: one Map.get + one property read; the {config,
 *  samplingHit} object is destructured immediately by the runCycle
 *  caller so V8 escape analysis can elide the allocation. */
export const beginCycle = (state: State): { config: PerfConfig | undefined; samplingHit: boolean } => {
  const config = readPerfConfig(state);
  if (!config?.enabled) {
    // Disabled path — no scratch mutation, no further cost.
    return { config, samplingHit: false };
  }
  const scratch = state.perfScratch;
  scratch.cycleN++;
  const rate = config.sampleRate ?? 1;
  return { config, samplingHit: rate <= 1 || scratch.cycleN % rate === 0 };
};

// ── Per-fn / per-cel accumulation helpers ──────────────────────────────────

export const recordFireTiming = (
  state: State,
  cel: Cel,
  durationNs: number,
  waveIndex: number,
  watchSet: Set<Key> | undefined,
): void => {
  const scratch = state.perfScratch;
  scratch.firedCount++;

  // Per-fn bucket — keyed by lambda key when the cel has one, otherwise
  // by cel key (covers per-cel compiled formula bodies).
  const fnKey: LambdaKey = cel.l ?? cel.key;
  let bucket = state.perfFunctions.get(fnKey);
  if (!bucket) {
    bucket = { calls: 0, totalNs: 0, lastNs: 0 };
    state.perfFunctions.set(fnKey, bucket);
  }
  bucket.calls++;
  bucket.totalNs += durationNs;
  bucket.lastNs = durationNs;

  // Per-wave bucket.
  let wave = scratch.waveStats.get(waveIndex);
  if (!wave) {
    wave = { fired: 0, skipped: 0, durationNs: 0, parallelism: 0 };
    scratch.waveStats.set(waveIndex, wave);
  }
  wave.fired++;
  wave.durationNs += durationNs;

  // Per-cel watch list.
  if (watchSet && watchSet.has(cel.key)) {
    scratch.watchedCelTimings.set(cel.key, durationNs);
  }
};

export const recordSkip = (state: State, waveIndex: number): void => {
  const scratch = state.perfScratch;
  scratch.skippedCount++;
  let wave = scratch.waveStats.get(waveIndex);
  if (!wave) {
    wave = { fired: 0, skipped: 0, durationNs: 0, parallelism: 0 };
    scratch.waveStats.set(waveIndex, wave);
  }
  wave.skipped++;
};

/** Record a wave's wall-clock duration and the maximum number of cels
 *  that fired concurrently within it. */
export const recordWaveTiming = (
  state: State,
  waveIndex: number,
  wallNs: number,
  parallelism: number,
): void => {
  const scratch = state.perfScratch;
  let wave = scratch.waveStats.get(waveIndex);
  if (!wave) {
    wave = { fired: 0, skipped: 0, durationNs: 0, parallelism: 0 };
    scratch.waveStats.set(waveIndex, wave);
  }
  // Wall-clock dominates the per-fire sum when fires were concurrent —
  // store the max so later reports reflect the actual cycle pacing.
  if (wallNs > wave.durationNs) wave.durationNs = wallNs;
  if (parallelism > wave.parallelism) wave.parallelism = parallelism;
};

// ── Channel instrumentation ────────────────────────────────────────────────

export const recordChannelEnqueue = (state: State, key: ChannelKey): void => {
  let bucket = state.perfChannels.get(key);
  if (!bucket) {
    bucket = { enqueues: 0, drains: 0, queueDepth: 0 };
    state.perfChannels.set(key, bucket);
  }
  bucket.enqueues++;
  bucket.queueDepth++;
};

export const recordChannelDrain = (state: State, key: ChannelKey): void => {
  let bucket = state.perfChannels.get(key);
  if (!bucket) {
    bucket = { enqueues: 0, drains: 0, queueDepth: 0 };
    state.perfChannels.set(key, bucket);
  }
  bucket.drains++;
  bucket.queueDepth = 0;
};

/** Wrap each registered channel's `drain` so completions show up in
 *  stats_channels. Idempotent — a channel already in the side-cache is
 *  not re-wrapped. v1: no auto-unwrap; toggling tracking off requires
 *  a fresh state. */
export const ensureChannelDrainsWrapped = (state: State): void => {
  const wrapped = state._perfWrappedChannels ?? (state._perfWrappedChannels = new Map());
  for (const [key, handler] of state.channelRegistry) {
    if (wrapped.has(key)) continue;
    wrapped.set(key, handler);
    const originalDrain = handler.drain;
    // Replace with a wrapped function that delegates and records on
    // completion (sync + async paths both covered).
    const replacement: ChannelHandler = {
      enqueue: handler.enqueue,
      hasPending: handler.hasPending,
      dispose: handler.dispose,
      drain: () => {
        const r = originalDrain.call(handler);
        if (r instanceof Promise) {
          return r.then(() => { recordChannelDrain(state, key); });
        }
        recordChannelDrain(state, key);
        return r;
      },
    };
    state.channelRegistry.set(key, replacement);
  }
};

// ── Snapshot builders ──────────────────────────────────────────────────────

export interface CycleSnapshot {
  cycleN: number;
  trigger: Key | "batch" | undefined;
  cycleNs: number;
  firedCount: number;
  skippedCount: number;
  waveStats: Array<{ wave: number; fired: number; skipped: number; durationNs: number; parallelism: number }>;
  watchedCelTimings: Record<Key, number>;
  configEnvGen: number;
}

export const buildCycleSnapshot = (state: State): CycleSnapshot => {
  const scratch = state.perfScratch;
  const cycleNs = nowNs() - scratch.cycleStartNs;
  const waveStats: CycleSnapshot["waveStats"] = [];
  const sortedWaves = [...scratch.waveStats.keys()].sort((a, b) => a - b);
  for (const w of sortedWaves) {
    const stats = scratch.waveStats.get(w)!;
    waveStats.push({ wave: w, ...stats });
  }
  const watched: Record<Key, number> = {};
  for (const [k, ns] of scratch.watchedCelTimings) watched[k] = ns;
  const envGen = (state.cels.get(CONFIG_ENVIRONMENT)?.v as { gen?: number } | undefined)?.gen ?? 0;
  return {
    cycleN: scratch.cycleN,
    trigger: scratch.trigger,
    cycleNs,
    firedCount: scratch.firedCount,
    skippedCount: scratch.skippedCount,
    waveStats,
    watchedCelTimings: watched,
    configEnvGen: envGen,
  };
};

export interface FunctionSnapshot {
  functions: Record<LambdaKey, { calls: number; totalNs: number; lastNs: number; meanNs: number }>;
  totalCalls: number;
  totalNs: number;
}

export const buildFunctionSnapshot = (
  perfFunctions: Map<LambdaKey, { calls: number; totalNs: number; lastNs: number }>,
): FunctionSnapshot => {
  const out: FunctionSnapshot["functions"] = {};
  let totalCalls = 0;
  let totalNs = 0;
  for (const [key, b] of perfFunctions) {
    out[key] = {
      calls: b.calls,
      totalNs: b.totalNs,
      lastNs: b.lastNs,
      meanNs: b.calls > 0 ? Math.floor(b.totalNs / b.calls) : 0,
    };
    totalCalls += b.calls;
    totalNs += b.totalNs;
  }
  return { functions: out, totalCalls, totalNs };
};

export interface ChannelSnapshot {
  channels: Record<ChannelKey, { enqueues: number; drains: number; queueDepth: number }>;
  totalEnqueues: number;
  totalDrains: number;
}

export const buildChannelSnapshot = (
  perfChannels: Map<ChannelKey, { enqueues: number; drains: number; queueDepth: number }>,
): ChannelSnapshot => {
  const out: ChannelSnapshot["channels"] = {};
  let totalEnqueues = 0;
  let totalDrains = 0;
  for (const [key, b] of perfChannels) {
    out[key] = { ...b };
    totalEnqueues += b.enqueues;
    totalDrains += b.drains;
  }
  return { channels: out, totalEnqueues, totalDrains };
};

export interface CelSnapshotEntry {
  key: Key;
  segment: Key | undefined;
  fanIn: number;
  fanOut: number;
  wave: number;
  estimatedBytes: number;
}

export interface PrecomputeSnapshot {
  totalCels: number;
  totalEstimatedBytes: number;
  deepestPath: number;
  waveHistogram: Record<number, number>;
  segmentHistogram: Record<string, number>;
  cels?: CelSnapshotEntry[];
  configEnvGen: number;
}

const sizeOfCel = (cel: Cel, state: State): number => {
  // 0. Ref cels have a fixed small footprint (no local v, no _fn,
  //    no _evaluate, no _inputEntries). Their schema's byteLength
  //    would double-count the source's column, so we short-circuit
  //    here BEFORE consulting tag / schema estimators. The source's
  //    own size is reported separately when we walk the source cel.
  if (cel.ref) return REF_CEL_BYTES;
  if (cel.v == null) return 0;
  // 1. tag handler
  if (cel.tag !== undefined) {
    const handler = state.tagRegistry.get(cel.tag);
    if (handler?.byteLength) {
      try { return handler.byteLength(cel.v); } catch { /* fall through */ }
    }
  }
  // 2. schema metadata
  if (cel.schema !== undefined) {
    // Reverse-lookup schema key. Walked once per cel — the table is
    // tiny in practice.
    for (const [k, zod] of state.schemas) {
      if (zod !== cel.schema) continue;
      const meta = state.schemaMetadata.get(k);
      const fnKey = meta?.byteLength;
      if (fnKey) {
        const fn = state.fns.get(fnKey);
        if (fn) {
          try {
            const r = fn(cel.v);
            if (typeof r === "number") return r;
          } catch { /* fall through */ }
        }
      }
      break;
    }
  }
  // 3. default
  return estimateBytes(cel.v);
};

export const computePrecomputeSnapshot = (state: State, includeCelDetail: boolean): PrecomputeSnapshot => {
  const fanIn = new Map<Key, number>();
  const fanOut = new Map<Key, number>();
  for (const cel of state.cels.values()) {
    if (!cel.inputMap) continue;
    let fi = 0;
    for (const ref of Object.values(cel.inputMap)) {
      if (Array.isArray(ref)) {
        fi += ref.length;
        for (const r of ref) fanOut.set(r, (fanOut.get(r) ?? 0) + 1);
      } else {
        fi++;
        fanOut.set(ref, (fanOut.get(ref) ?? 0) + 1);
      }
    }
    fanIn.set(cel.key, fi);
  }

  const waveHistogram: Record<number, number> = {};
  const segmentHistogram: Record<string, number> = {};
  let totalCels = 0;
  let totalEstimatedBytes = 0;
  let deepestPath = 0;
  const detail: CelSnapshotEntry[] | undefined = includeCelDetail ? [] : undefined;

  for (const cel of state.cels.values()) {
    totalCels++;
    const wave = cel.wave ?? 0;
    waveHistogram[wave] = (waveHistogram[wave] ?? 0) + 1;
    if (wave > deepestPath) deepestPath = wave;
    const seg = cel.segment ?? "default";
    segmentHistogram[seg] = (segmentHistogram[seg] ?? 0) + 1;

    const bytes = sizeOfCel(cel, state);
    totalEstimatedBytes += bytes;

    if (detail) {
      detail.push({
        key: cel.key,
        segment: cel.segment,
        fanIn: fanIn.get(cel.key) ?? 0,
        fanOut: fanOut.get(cel.key) ?? 0,
        wave,
        estimatedBytes: bytes,
      });
    }
  }

  const envGen = (state.cels.get(CONFIG_ENVIRONMENT)?.v as { gen?: number } | undefined)?.gen ?? 0;
  return {
    totalCels,
    totalEstimatedBytes,
    deepestPath,
    waveHistogram,
    segmentHistogram,
    ...(detail ? { cels: detail } : {}),
    configEnvGen: envGen,
  };
};

// ── Flush helpers — write snapshots into stats cels ─────────────────────────

/** Direct cel.v mutation, NOT through setCel — these writes happen
 *  inside runCycle / precompute and must not re-enter the cycle.
 *  Downstream lambdas observe via `dynamic: true` on the stats cel:
 *  they re-fire on the NEXT cycle. When a stats cel has channel
 *  bindings, the caller is responsible for invoking enqueueChannels
 *  explicitly so observers see the update within this cycle. */
export const flushCycleStats = (state: State): void => {
  const cyc = state.cels.get(STATS_CYCLES);
  if (cyc) {
    cyc.v = buildCycleSnapshot(state);
  }
  const fns = state.cels.get(STATS_FUNCTIONS);
  if (fns) {
    fns.v = buildFunctionSnapshot(state.perfFunctions);
  }
  const chs = state.cels.get(STATS_CHANNELS);
  if (chs) {
    chs.v = buildChannelSnapshot(state.perfChannels);
  }
};

export const flushPrecomputeStats = (state: State, includeCelDetail = false): void => {
  const cel = state.cels.get(STATS_PRECOMPUTE);
  if (!cel) return;
  cel.v = computePrecomputeSnapshot(state, includeCelDetail);
};
