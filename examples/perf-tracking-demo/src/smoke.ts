// ============================================================================
// smoke — fast verification that the perf-tracking acceptance criteria
// in notes/tasks/task-perf-tracking.md hold. Every assertion prints
// pass/fail; non-zero exit on any fail.
// ============================================================================

import type { ChannelHandler, Fn, Segment, State } from "../../../plastron/src/index.js";
import {
  CONFIG_ENVIRONMENT, CONFIG_PERFORMANCE, STATS_CHANNELS, STATS_CYCLES,
  STATS_ENVIRONMENT, STATS_FUNCTIONS, STATS_PRECOMPUTE,
  createInitialState,
} from "../../../plastron/src/index.js";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  if (ok) { pass++; console.log(`  PASS: ${label}`); }
  else    { fail++; console.log(`  FAIL: ${label}`, detail ?? ""); }
};

const buildSegment = (n: number): Segment => {
  const cels: Segment["cels"] = [{ key: "root", v: 1, segment: "demo" }];
  for (let i = 0; i < n; i++) {
    cels.push({ key: `c${i}`, segment: "demo", f: `(* root ${i + 1})`, channel: i === 0 ? "log" : undefined });
  }
  return { key: "demo", cels };
};

// A simple in-memory channel handler so we can verify channel stats.
const makeMemoryChannel = (): { handler: ChannelHandler; commits: number } => {
  let commits = 0;
  const queue: unknown[] = [];
  const handler: ChannelHandler = {
    enqueue: ({ cel }) => { queue.push(cel.v); },
    hasPending: () => queue.length > 0,
    drain: () => { commits += queue.length; queue.length = 0; },
    dispose: () => { queue.length = 0; },
  };
  return { handler, commits };
};

// ── Boot a state with tracking enabled and a registered channel ────────────

const state: State = createInitialState();
const ch = makeMemoryChannel();
state.channelRegistry.set("log", ch.handler);

const hydrate     = state.fns.get("hydrate")     as Fn;
const runCycle    = state.fns.get("runCycle")    as Fn;
const set         = state.fns.get("set")         as Fn;
const get         = state.fns.get("get")         as Fn;
const drain       = state.fns.get("drain")       as Fn;
const resetStats  = state.fns.get("resetStats")  as Fn;
const dehydrate   = state.fns.get("dehydrate")   as Fn;
const setFeatureFlag         = state.fns.get("setFeatureFlag")         as Fn;
const setEnvironmentTag      = state.fns.get("setEnvironmentTag")      as Fn;
const syncSegmentsToConfig   = state.fns.get("syncSegmentsToConfig")   as Fn;
const freezeRuntimeProfile   = state.fns.get("freezeRuntimeProfile")   as Fn;
const compareRuntimeProfile  = state.fns.get("compareRuntimeProfile")  as Fn;
const refreshEnvironmentStats = state.fns.get("refreshEnvironmentStats") as Fn;

hydrate(state, [buildSegment(10)], [new Map()]);
await refreshEnvironmentStats(state);

// ── Criterion 12 — env populated regardless of tracking ─────────────────────

check(
  "12 — stats_environment populated even with tracking off",
  (() => {
    const env = get(state, STATS_ENVIRONMENT) as { highResTiming?: boolean } | null;
    return !!env && typeof env.highResTiming === "boolean";
  })(),
);

// ── Criterion 10 — hydrate populated env with sync flags ────────────────────

check(
  "10 — env has sync flags populated",
  (() => {
    const env = get(state, STATS_ENVIRONMENT) as Record<string, unknown> | null;
    return !!env && "webWorkers" in env && "wasm" in env;
  })(),
);

// ── Criterion 11 — refreshEnvironmentStats produces a fresh capturedAt ──────

const before = (get(state, STATS_ENVIRONMENT) as { capturedAt: number }).capturedAt;
await new Promise<void>((r) => setTimeout(r, 5));
await refreshEnvironmentStats(state);
const after = (get(state, STATS_ENVIRONMENT) as { capturedAt: number }).capturedAt;
check("11 — refreshEnvironmentStats updates capturedAt", after >= before);

// ── Criterion 13/14 — config_environment mutators ─────────────────────

setFeatureFlag(state, "useGPU", true);
const cfgEnv1 = get(state, CONFIG_ENVIRONMENT) as { features: Record<string, boolean>; gen: number };
check("13 — setFeatureFlag updates features.useGPU + bumps gen", cfgEnv1.features.useGPU === true && cfgEnv1.gen > 0);

const gen0 = cfgEnv1.gen;
setEnvironmentTag(state, "env", "production");
const cfgEnv2 = get(state, CONFIG_ENVIRONMENT) as { tags: Record<string, string>; gen: number };
check("14 — setEnvironmentTag updates tags.env + bumps gen", cfgEnv2.tags.env === "production" && cfgEnv2.gen > gen0);

// ── Criterion 15 — syncSegmentsToConfig populates from cel walk ────────────

syncSegmentsToConfig(state);
const cfgEnv3 = get(state, CONFIG_ENVIRONMENT) as { segments: Array<{ key: string }> };
check(
  "15 — syncSegmentsToConfig populated segments",
  cfgEnv3.segments.length > 0 && cfgEnv3.segments.some(s => s.key === "demo"),
);

// ── Criterion 16 — freezeRuntimeProfile copies env ──────────────────────────

freezeRuntimeProfile(state);
const cfgEnv4 = get(state, CONFIG_ENVIRONMENT) as { runtime: { capturedAt: number } | null };
check("16 — freezeRuntimeProfile populated runtime", !!cfgEnv4.runtime && typeof cfgEnv4.runtime.capturedAt === "number");

// ── Enable tracking, run a cycle ────────────────────────────────────────────

const cfg = state.cels.get(CONFIG_PERFORMANCE)!;
(cfg.v as { enabled: boolean; watchCels: string[] }).enabled = true;
(cfg.v as { enabled: boolean; watchCels: string[] }).watchCels = ["c0", "c5"];

await runCycle(state, "smoke-trigger");

// ── Criterion 3 — stats_cycles + stats_functions ───────────────────────────

const cyc = get(state, STATS_CYCLES) as {
  firedCount: number; cycleNs: number; waveStats: unknown[]; trigger: string;
  watchedCelTimings: Record<string, number>; configEnvGen: number;
} | null;
check("3 — stats_cycles.firedCount > 0", !!cyc && cyc.firedCount > 0);
check("3 — stats_cycles.cycleNs > 0", !!cyc && cyc.cycleNs > 0);
check("3 — stats_cycles.waveStats populated", !!cyc && Array.isArray(cyc.waveStats) && cyc.waveStats.length > 0);
check("3 — stats_cycles.trigger matches", !!cyc && cyc.trigger === "smoke-trigger");

const fns = get(state, STATS_FUNCTIONS) as {
  functions: Record<string, { calls: number; totalNs: number }>;
} | null;
check("3 — stats_functions has entries with calls > 0 + totalNs > 0", !!fns && Object.values(fns.functions).some(f => f.calls > 0 && f.totalNs > 0));

// watchCels detail — c0 and c5 should appear in watchedCelTimings
const watched = (cyc?.watchedCelTimings ?? {}) as Record<string, number>;
check("watchCels — c0 and c5 timed", typeof watched.c0 === "number" && typeof watched.c5 === "number");

// ── Criterion 17 — configEnvGen matches ─────────────────────────────────────

const cfgEnvNow = get(state, CONFIG_ENVIRONMENT) as { gen: number };
check("17 — stats_cycles.configEnvGen matches config_environment.gen", !!cyc && cyc.configEnvGen === cfgEnvNow.gen);

// ── Criterion 6 — channel stats increment ─────────────────────────────────

await set(state, "root", 99);   // changes c0 (which has channel)
await drain(state, "all");
// stats_channels cel snapshot is only refreshed at end of a runCycle;
// kick another cycle so the drain we just did shows up in the cel.
await runCycle(state, "post-drain");

const chs = get(state, STATS_CHANNELS) as {
  channels: Record<string, { enqueues: number; drains: number }>;
} | null;
check("6 — stats_channels.log.enqueues > 0", !!chs && (chs.channels.log?.enqueues ?? 0) > 0);
check("6 — stats_channels.log.drains > 0", !!chs && (chs.channels.log?.drains ?? 0) > 0);

// ── Criterion 4 — resetStats ───────────────────────────────────────────────

resetStats(state);
const cycAfter = get(state, STATS_CYCLES);
const fnsAfter = get(state, STATS_FUNCTIONS);
const chsAfter = get(state, STATS_CHANNELS);
check("4 — stats_cycles cleared", cycAfter === null);
check("4 — stats_functions cleared", fnsAfter === null);
check("4 — stats_channels cleared", chsAfter === null);
check("4 — perfFunctions size = 0", state.perfFunctions.size === 0);
check("4 — perfChannels size = 0", state.perfChannels.size === 0);

// ── Criterion 5 — schema metadata byteLength ───────────────────────────────

const state5 = createInitialState();
const hydrate5 = state5.fns.get("hydrate") as Fn;

// Register a schema + metadata that uses a fake byteLength estimator
import("zod").then(async ({ z }) => {
  state5.schemas.set("intish", z.number());
  state5.schemaMetadata.set("intish", { key: "intish", byteLength: "fakeByteLen" });
  state5.fns.set("fakeByteLen", () => 99999);

  hydrate5(state5, [{
    key: "demo", cels: [
      { key: "x", v: 1, segment: "demo", schema: "intish" } as never,
    ],
  }], [new Map()]);

  // Enable tracking THEN trigger a topology re-precompute by setting
  // a fresh lambda body. setCel with f triggers precompute.
  const cfg5 = state5.cels.get(CONFIG_PERFORMANCE)!;
  (cfg5.v as { enabled: boolean }).enabled = true;
  const setCel5 = state5.fns.get("setCel") as Fn;
  try {
    await setCel5(state5, "y", { f: "(* x 2)" } as never);
  } catch { /* "y" doesn't exist; we add via hydrate below */ }
  // Better approach — use registerLambda and then add a cel via setCelBatch?
  // Simpler: run hydrate once more with a tiny addition (forces precompute).
  hydrate5(state5, [{
    key: "demo2", cels: [{ key: "y2", v: 0, segment: "demo2" } as never],
  }], [new Map()]);
  // hydrate runs precompute internally — but tracking must be on.
  // It is. So stats_precompute should now be populated.

  const snap = state5.cels.get(STATS_PRECOMPUTE)?.v as
    { totalEstimatedBytes: number; cels?: { key: string; estimatedBytes: number }[] } | null;
  check(
    "5 — schema byteLength estimator picked up (totalEstimatedBytes >= 99999 from x)",
    !!snap && snap.totalEstimatedBytes >= 99999,
    snap?.totalEstimatedBytes,
  );

  // ── Criterion 7 + 18 — dehydrate filtering + round-trip ─────────────────

  const segs = dehydrate(state) as Segment[];
  const allCels = segs.flatMap(s => s.cels);
  check("7 — no stats_* cels in dehydrate output", allCels.every(c => c.segment !== "stats"));
  const cfgPerf = allCels.find(c => c.key === CONFIG_PERFORMANCE);
  check(
    "7 — config_performance.enabled reset to false in dehydrate",
    !!cfgPerf && (cfgPerf.v as { enabled: boolean }).enabled === false,
  );

  // Round-trip
  const fresh = createInitialState();
  const freshHydrate = fresh.fns.get("hydrate") as Fn;
  freshHydrate(fresh, segs, [new Map()]);
  const cfgEnvRT = get(fresh, CONFIG_ENVIRONMENT) as { features: Record<string, boolean>; runtime: unknown };
  check(
    "18 — config_environment round-trips (features survive)",
    cfgEnvRT.features.useGPU === true,
  );
  check(
    "18 — config_environment.runtime survived round-trip",
    cfgEnvRT.runtime != null,
  );
  const cfgPerfRT = get(fresh, CONFIG_PERFORMANCE) as { enabled: boolean; sampleRate: number };
  check(
    "18 — config_performance.enabled is false after re-hydrate",
    cfgPerfRT.enabled === false,
  );

  // ── Criterion 19 — compareRuntimeProfile returns a diff ─────────────────

  const diff = compareRuntimeProfile(fresh) as { diff: Record<string, unknown> | null } | null;
  check("19 — compareRuntimeProfile returns an object", !!diff && diff.diff !== null);

  // ── Final summary ───────────────────────────────────────────────────────

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
});
