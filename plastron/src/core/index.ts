import type { Fn, Key, LambdaKey, LambdaMetadata, State } from "../types/index.js";
import { hydrate, dehydrate } from "./hydrate.js";
import { runCycle } from "./runCycle.js";
import {
  get, set, update, batch, touch, consume, drain,
  getCel, getCelBatch, setCel, setCelBatch, registerLambda,
} from "./input.js";
import { flush } from "./flush.js";
import { compileFormula, extractDeps } from "./formula.js";
import { refCelByteLength, REF_CEL_BYTELENGTH_KEY } from "./refs.js";
import { findDependents, getSegmentManifest, listSegments } from "./segments.js";
import {
  CONFIG_ENVIRONMENT, STATS_CHANNELS, STATS_CYCLES, STATS_ENVIRONMENT,
  STATS_FUNCTIONS,
} from "./perf.js";
import { captureEnvironment, type EnvironmentSnapshot } from "./perf-env.js";

// ============================================================================
// coreFns + coreFnMetadata — the default fn registry and the parallel
// metadata that drives lock policy. Both are derived from coreFnEntries
// below; createInitialState clones both into state.fns and state.fnMetadata.
//
// state.fns is bare Fn (no per-entry record). The locked attribute
// lives on LambdaMetadata in state.fnMetadata and is consulted by
// hydrate before overwriting an existing fn.
//
// Most built-ins are locked — replacing hydrate, runCycle, get, set
// would break invariants. The formula compiler "f" is unlocked: it's
// a compile-time helper that hydrate looks up to turn cel.f source
// into cel._fn. Hosts swap formula languages by registering a
// replacement Fn at "f" (with a matching `.extractDeps`) via the fns
// parameter to hydrate.
//
// precompute is intentionally absent: hydrate calls it directly and
// it never enters the registry.
// ============================================================================

// Compiler-shaped fn: takes a formula source string and returns the
// runtime Fn that hydrate will store at cel._fn. The `extractDeps`
// property is consulted by hydrate to auto-wire cel.inputMap.
const formulaFn: Fn = (src: string) => compileFormula(src);
formulaFn.extractDeps = extractDeps;

interface CoreFnEntry {
  key: LambdaKey;
  fn: Fn;
  locked: boolean;
}

// ── Perf-tracking core fns ──────────────────────────────────────────────────

const resetStats: Fn = (state: State) => {
  state.perfFunctions.clear();
  state.perfChannels.clear();
  state.perfScratch.waveStats.clear();
  state.perfScratch.watchedCelTimings.clear();
  state.perfScratch.firedCount = 0;
  state.perfScratch.skippedCount = 0;
  // Don't clear cycleN — used for sampling.
  const sc  = state.cels.get(STATS_CYCLES);    if (sc)  sc.v = null;
  const sf  = state.cels.get(STATS_FUNCTIONS); if (sf)  sf.v = null;
  const sch = state.cels.get(STATS_CHANNELS);  if (sch) sch.v = null;
  // stats_precompute is rebuilt by precompute, leave untouched.
  // config_environment is project metadata, never reset by stats reset.
  return state;
};

// Async — invokes the full env probe (including the awaitable WebGPU
// adapter request). Callers retrieving this via state.fns.get("…")
// must await the result; the sync probe runs at boot in
// createInitialState (and does not need awaiting).
const refreshEnvironmentStats: Fn = async (state: State) => {
  const cel = state.cels.get(STATS_ENVIRONMENT);
  if (!cel) return state;
  cel.v = await captureEnvironment();
  // Notify any channel observers bound to stats_environment.
  if (cel._channelHandlers) {
    for (const h of cel._channelHandlers) h.enqueue({ cel, state });
  } else if (cel.channel) {
    const keys = Array.isArray(cel.channel) ? cel.channel : [cel.channel];
    for (const k of keys) state.channelRegistry.get(k)?.enqueue({ cel, state });
  }
  return state;
};

// ── config_environment mutators ─────────────────────────────────────────────
//
// All four mutate cel.v directly and bump `gen`. They do NOT trigger
// a cycle — downstream lambdas observing config_environment re-fire
// on the next cycle (lambdas declare it in inputMap; gen bumps make
// isChanged report true).

interface EnvConfigShape {
  segments: Array<{ key: Key; version?: string }>;
  features: Record<string, boolean>;
  tags: Record<string, string | number | boolean>;
  runtime: EnvironmentSnapshot | null;
  gen: number;
}

const setFeatureFlag: Fn = (state: State, name: string, value: boolean) => {
  const cel = state.cels.get(CONFIG_ENVIRONMENT);
  if (!cel) return state;
  const v = cel.v as EnvConfigShape;
  v.features[name] = value;
  v.gen++;
  return state;
};

const setEnvironmentTag: Fn = (state: State, name: string, value: string | number | boolean) => {
  const cel = state.cels.get(CONFIG_ENVIRONMENT);
  if (!cel) return state;
  const v = cel.v as EnvConfigShape;
  v.tags[name] = value;
  v.gen++;
  return state;
};

const syncSegmentsToConfig: Fn = (state: State) => {
  const cel = state.cels.get(CONFIG_ENVIRONMENT);
  if (!cel) return state;
  const v = cel.v as EnvConfigShape;
  // Union of state.segments (manifest-bearing — gets version) and
  // cel.segment walk (catches segments hydrated without manifests).
  // Manifest entries win on the version field for any overlap.
  const seen = new Map<Key, { key: Key; version?: string }>();
  for (const c of state.cels.values()) {
    if (c.segment && !seen.has(c.segment)) seen.set(c.segment, { key: c.segment });
  }
  for (const m of state.segments.values()) {
    const k = m.segment ?? "";
    if (k) seen.set(k, { key: k, version: m.version });
  }
  v.segments = [...seen.values()];
  v.gen++;
  return state;
};

const freezeRuntimeProfile: Fn = (state: State) => {
  const env  = state.cels.get(STATS_ENVIRONMENT);
  const conf = state.cels.get(CONFIG_ENVIRONMENT);
  if (!env || !conf) return state;
  const v = conf.v as EnvConfigShape;
  v.runtime = env.v as EnvironmentSnapshot;
  v.gen++;
  return state;
};

const compareRuntimeProfile: Fn = (state: State) => {
  const conf = state.cels.get(CONFIG_ENVIRONMENT);
  const env  = state.cels.get(STATS_ENVIRONMENT);
  if (!conf || !env) return null;
  const recorded = (conf.v as EnvConfigShape).runtime;
  const live = env.v as EnvironmentSnapshot | null;
  if (!recorded || !live) return { recorded, live, diff: null };
  const diff: Record<string, { recorded: unknown; live: unknown }> = {};
  for (const k of Object.keys(recorded) as Array<keyof EnvironmentSnapshot>) {
    if (k === "capturedAt") continue;
    if ((recorded as unknown as Record<string, unknown>)[k] !==
        (live     as unknown as Record<string, unknown>)[k]) {
      diff[k as string] = {
        recorded: (recorded as unknown as Record<string, unknown>)[k],
        live:     (live     as unknown as Record<string, unknown>)[k],
      };
    }
  }
  return { recorded, live, diff };
};

const coreFnEntries: ReadonlyArray<CoreFnEntry> = [
  { key: "get",                     fn: get,                     locked: true  },
  { key: "set",                     fn: set,                     locked: true  },
  { key: "update",                  fn: update,                  locked: true  },
  { key: "batch",                   fn: batch,                   locked: true  },
  { key: "getCel",                  fn: getCel,                  locked: true  },
  { key: "setCel",                  fn: setCel,                  locked: true  },
  { key: "getCelBatch",             fn: getCelBatch,             locked: true  },
  { key: "setCelBatch",             fn: setCelBatch,             locked: true  },
  { key: "touch",                   fn: touch,                   locked: true  },
  { key: "consume",                 fn: consume,                 locked: true  },
  { key: "runCycle",                fn: runCycle,                locked: true  },
  { key: "hydrate",                 fn: hydrate,                 locked: true  },
  { key: "dehydrate",               fn: dehydrate,               locked: true  },
  { key: "flush",                   fn: flush,                   locked: true  },
  { key: "drain",                   fn: drain,                   locked: true  },
  { key: "registerLambda",          fn: registerLambda,          locked: true  },
  // Perf-tracking core fns.
  { key: "resetStats",              fn: resetStats,              locked: true  },
  { key: "refreshEnvironmentStats", fn: refreshEnvironmentStats, locked: true  },
  { key: "setFeatureFlag",          fn: setFeatureFlag,          locked: true  },
  { key: "setEnvironmentTag",       fn: setEnvironmentTag,       locked: true  },
  { key: "syncSegmentsToConfig",    fn: syncSegmentsToConfig,    locked: true  },
  { key: "freezeRuntimeProfile",    fn: freezeRuntimeProfile,    locked: true  },
  { key: "compareRuntimeProfile",   fn: compareRuntimeProfile,   locked: true  },
  // Segment-manifest introspection. Sync, side-effect-free.
  { key: "getSegmentManifest",      fn: getSegmentManifest as Fn, locked: true },
  { key: "listSegments",            fn: listSegments       as Fn, locked: true },
  { key: "findDependents",          fn: findDependents     as Fn, locked: true },
  // Ref-cel byte estimator. Registered under the conventional key so
  // host tooling can call it directly via state.fns; the perf-tracking
  // accountant short-circuits on cel.ref before the registry lookup.
  { key: REF_CEL_BYTELENGTH_KEY,    fn: refCelByteLength,        locked: true  },
  { key: "f",                       fn: formulaFn,               locked: false },
];

export const coreFns: Map<LambdaKey, Fn> = new Map(
  coreFnEntries.map((e) => [e.key, e.fn]),
);

export const coreFnMetadata: Map<LambdaKey, LambdaMetadata> = new Map(
  coreFnEntries.map((e) => [e.key, { key: e.key, locked: e.locked }]),
);
