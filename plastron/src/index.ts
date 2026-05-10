import type { z } from "zod";
import type { Cel, Key, SchemaKey, SegmentManifest, SlotAccessor, State, TagKey } from "./types/index.js";
import { coreFns, coreFnMetadata } from "./core/index.js";
import {
  DEFAULT_ARRAY_ACCESSOR_KEY, DEFAULT_OBJECT_ACCESSOR_KEY,
  defaultArrayAccessor, defaultObjectAccessor,
} from "./core/refs.js";
import {
  CONFIG_ENVIRONMENT, CONFIG_PERFORMANCE, CONFIG_SEGMENT,
  DEFAULT_PERF_CONFIG, PERF_CONFIG_SCHEMA, PERF_CONFIG_SCHEMA_KEY,
  STATS_CHANNELS, STATS_CYCLES, STATS_ENVIRONMENT,
  STATS_FUNCTIONS, STATS_PRECOMPUTE, STATS_SEGMENT,
} from "./core/perf.js";
import { captureEnvironmentSync, resolveWebGPUAdapter } from "./core/perf-env.js";
import { PRECOMPUTED_STATES_KEY, type PrecomputedIndexes } from "./core/precompute.js";

// ============================================================================
// createInitialState — return a fresh State with coreFns preinstalled,
// the precomputedStates seed cel locked, and locked metadata seeded
// for every core fn so subsequent hydrates can't overwrite them.
//
// Also seeds:
//   • state.segments with a single "core" manifest declaring the
//     bootstrap registry (core fns + the locked precomputedStates seed
//     cel). Hosts can introspect via the `listSegments` core fn even
//     before any user segment hydrates.
//   • Six perf cels under "config" / "stats" segments. Tracking is
//     off by default (config_performance.v.enabled === false) — the
//     cels are present so downstream lambdas referencing them work
//     even when tracking is disabled (they just see null).
//
// Calling convention: every kernel fn receives positional args. To run
// hydrate or runCycle, pass `(state, …)`:
//
//   const state = createInitialState();
//   state.fns.get("hydrate")!(state, [mySeg], [myFns]);
//   await state.fns.get("runCycle")!(state);
// ============================================================================

const seedPrecomputedStatesCel = (): Cel => ({
  key: PRECOMPUTED_STATES_KEY,
  v: {
    waveCascade: new Map(),
    sortedWaves: [],
    children: new Map(),
    downstream: new Map(),
    dynamicCascade: new Set(),
  } satisfies PrecomputedIndexes,
  segment: "core",
  locked: true,
});

const buildCoreManifest = (): SegmentManifest => ({
  segment: "core",
  version: "1.0.0",
  description: "Kernel-internal seeds. Always present.",
  provides: {
    celSegments: ["core"],
    lambdas: Array.from(coreFns.keys()),
  },
});

// Default value for config_environment.v — round-trips through dehydrate.
const defaultEnvironmentConfig = (): {
  segments: Array<{ key: Key; version?: string }>;
  features: Record<string, boolean>;
  tags: Record<string, string | number | boolean>;
  runtime: null;
  gen: number;
} => ({
  segments: [],
  features: {},
  tags: {},
  runtime: null,
  gen: 0,
});

const seedConfigPerformanceCel = (): Cel => {
  // Validate the seed against the bound schema. A misconfigured default
  // (or a future code change that drifts the type and the schema apart)
  // throws here at boot rather than silently mis-sampling at runtime.
  const v = PERF_CONFIG_SCHEMA.parse({ ...DEFAULT_PERF_CONFIG, watchCels: [] });
  return {
    key: CONFIG_PERFORMANCE,
    v,
    segment: CONFIG_SEGMENT,
    schema: PERF_CONFIG_SCHEMA,
  };
};

const seedConfigEnvironmentCel = (): Cel => ({
  key: CONFIG_ENVIRONMENT,
  v: defaultEnvironmentConfig(),
  segment: CONFIG_SEGMENT,
});

// Stats cels: dynamic so downstream observers re-fire each cycle.
const seedStatsCel = (key: Key): Cel => ({
  key,
  v: null,
  segment: STATS_SEGMENT,
  dynamic: true,
});

// stats_environment is the exception — it doesn't change cycle-to-cycle.
const seedStatsEnvironmentCel = (snap: unknown): Cel => ({
  key: STATS_ENVIRONMENT,
  v: snap,
  segment: STATS_SEGMENT,
});

export const createInitialState = (): State => {
  const cels = new Map<Key, Cel>();
  const seed = seedPrecomputedStatesCel();
  cels.set(seed.key, seed);

  const segments = new Map<Key, SegmentManifest>([
    ["core", buildCoreManifest()],
  ]);

  // Config cels — present from boot regardless of tracking state.
  cels.set(CONFIG_PERFORMANCE, seedConfigPerformanceCel());
  cels.set(CONFIG_ENVIRONMENT, seedConfigEnvironmentCel());

  // Stats cels — present from boot so downstream lambdas referencing
  // them work even when tracking is disabled (they just see null).
  cels.set(STATS_PRECOMPUTE, seedStatsCel(STATS_PRECOMPUTE));
  cels.set(STATS_CYCLES,     seedStatsCel(STATS_CYCLES));
  cels.set(STATS_FUNCTIONS,  seedStatsCel(STATS_FUNCTIONS));
  cels.set(STATS_CHANNELS,   seedStatsCel(STATS_CHANNELS));

  // stats_environment is populated immediately with the sync probe
  // (independent of config_performance.enabled). The async webGPU
  // adapter probe runs in the background and overwrites the field on
  // the same snapshot object once it resolves.
  const envSnap = captureEnvironmentSync();
  cels.set(STATS_ENVIRONMENT, seedStatsEnvironmentCel(envSnap));
  void resolveWebGPUAdapter(envSnap);

  // coreFns and coreFnMetadata are shared across every state instance,
  // so we clone — hydrate mutates state.fns / state.fnMetadata, and we
  // don't want those mutations leaking into the canonical registry.
  //
  // The PERF_CONFIG_SCHEMA is registered here so reverse-lookup
  // (state.schemas → SchemaKey) works for the config_performance cel —
  // matches the registration pattern of any host-supplied schema.
  const schemas = new Map<SchemaKey, z.ZodType>();
  schemas.set(PERF_CONFIG_SCHEMA_KEY, PERF_CONFIG_SCHEMA);

  // Default slot accessors for ref cels — handle plain arrays /
  // objects out of the box. Sources without a tag fall back to one of
  // these (selected by source-value shape in core/refs.ts). Segments
  // installing typed-array envelopes (Column, Table, Matrix) register
  // their own accessor under the corresponding tag key.
  const slotAccessors = new Map<TagKey, SlotAccessor>();
  slotAccessors.set(DEFAULT_ARRAY_ACCESSOR_KEY,  defaultArrayAccessor);
  slotAccessors.set(DEFAULT_OBJECT_ACCESSOR_KEY, defaultObjectAccessor);

  return {
    cels,
    fns:                  new Map(coreFns),
    fnMetadata:           new Map(coreFnMetadata),
    schemas,
    schemaMetadata:       new Map(),
    tagRegistry:          new Map(),
    slotAccessors,
    fnDispose:            new Map(),
    channelRegistry:      new Map(),
    precomputeGeneration: 0,
    segments,
    perfScratch: {
      cycleN: 0,
      cycleStartNs: 0,
      trigger: undefined,
      firedCount: 0,
      skippedCount: 0,
      waveStats: new Map(),
      watchedCelTimings: new Map(),
    },
    perfFunctions: new Map(),
    perfChannels:  new Map(),
  };
};

export type * from "./types/index.js";
export {
  getSegmentManifest, listSegments, findDependents, satisfies,
} from "./core/segments.js";
export {
  CONFIG_ENVIRONMENT, CONFIG_PERFORMANCE, CONFIG_SEGMENT,
  DEFAULT_PERF_CONFIG, PERF_CONFIG_SCHEMA, PERF_CONFIG_SCHEMA_KEY,
  STATS_CHANNELS, STATS_CYCLES, STATS_ENVIRONMENT,
  STATS_FUNCTIONS, STATS_PRECOMPUTE, STATS_SEGMENT,
} from "./core/perf.js";
export type {
  PerfConfig, CycleSnapshot, FunctionSnapshot, ChannelSnapshot,
  PrecomputeSnapshot, CelSnapshotEntry,
} from "./core/perf.js";
export type { EnvironmentSnapshot } from "./core/perf-env.js";
