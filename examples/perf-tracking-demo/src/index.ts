// ============================================================================
// perf-tracking-demo — enable plastron's opt-in perf tracking, run a
// small cascade, print every stats cel.
//
// Mirrors the acceptance criteria in notes/tasks/task-perf-tracking.md.
// Useful as living documentation: read top-to-bottom to see how a host
// turns tracking on, mutates the env profile, and consumes the snapshots.
// ============================================================================

import type { Fn, Segment, State } from "../../../plastron/src/index.js";
import {
  CONFIG_ENVIRONMENT, CONFIG_PERFORMANCE, STATS_CHANNELS, STATS_CYCLES,
  STATS_ENVIRONMENT, STATS_FUNCTIONS, STATS_PRECOMPUTE,
  createInitialState,
} from "../../../plastron/src/index.js";

// ── A small cascade: root + a fan-out of derived cels ──────────────────────

const buildSegment = (n: number): Segment => {
  const cels: Segment["cels"] = [
    { key: "root", v: 1, segment: "demo" },
  ];
  for (let i = 0; i < n; i++) {
    cels.push({ key: `c${i}`, segment: "demo", f: `(* root ${i + 1})` });
  }
  // Aggregator that sums the first 5 — fanIn shape.
  cels.push({
    key: "sum",
    segment: "demo",
    f: "(+ c0 c1 c2 c3 c4)",
  });
  return { key: "demo", cels };
};

// ── Boot ───────────────────────────────────────────────────────────────────

const state: State = createInitialState();
const hydrate                = state.fns.get("hydrate")                as Fn;
const runCycle               = state.fns.get("runCycle")               as Fn;
const set                    = state.fns.get("set")                    as Fn;
const get                    = state.fns.get("get")                    as Fn;
const setFeatureFlag         = state.fns.get("setFeatureFlag")         as Fn;
const setEnvironmentTag      = state.fns.get("setEnvironmentTag")      as Fn;
const syncSegmentsToConfig   = state.fns.get("syncSegmentsToConfig")   as Fn;
const freezeRuntimeProfile   = state.fns.get("freezeRuntimeProfile")   as Fn;
const compareRuntimeProfile  = state.fns.get("compareRuntimeProfile")  as Fn;
const refreshEnvironmentStats = state.fns.get("refreshEnvironmentStats") as Fn;
const resetStats             = state.fns.get("resetStats")             as Fn;
const dehydrate              = state.fns.get("dehydrate")              as Fn;

hydrate(state, [buildSegment(20)], [new Map()]);

// Refresh the environment cel — the sync portion was populated by
// createInitialState; this re-runs the full probe (incl. the async
// webGPU adapter check) so the printout is complete.
await refreshEnvironmentStats(state);

console.log("─── stats_environment (after refresh) ───");
console.log(get(state, STATS_ENVIRONMENT));

// ── Mutate the project env profile ─────────────────────────────────────────

setFeatureFlag(state, "useGPU", true);
setFeatureFlag(state, "useSAB", false);
setEnvironmentTag(state, "env", "demo");
setEnvironmentTag(state, "deploy", "v0.0.1");
syncSegmentsToConfig(state);
freezeRuntimeProfile(state);

console.log("\n─── config_environment (after host mutations) ───");
console.log(get(state, CONFIG_ENVIRONMENT));

// ── Enable perf tracking ───────────────────────────────────────────────────

const cfg = state.cels.get(CONFIG_PERFORMANCE)!;
(cfg.v as { enabled: boolean }).enabled = true;

// Force a fresh runCycle so config_performance and config_environment
// are observed at cycle entry.
console.log("\n─── running cycle 1 (full re-fire from scratch) ───");
await runCycle(state, "demo-boot");

console.log("\n─── stats_cycles (after cycle 1) ───");
console.log(get(state, STATS_CYCLES));

console.log("\n─── stats_functions (after cycle 1) ───");
console.log(get(state, STATS_FUNCTIONS));

// stats_precompute is written by precompute. Tracking was off when
// hydrate's precompute ran, so the cel is still null here. To force a
// fresh precompute we change a cel's body — a no-op edit suffices.
const setCel = state.fns.get("setCel") as Fn;
await setCel(state, "c0", { f: "(* root 1)" });   // identical body, but f-set forces re-precompute
console.log("\n─── stats_precompute (after forced re-precompute) ───");
console.log(get(state, STATS_PRECOMPUTE));

// ── Run another cycle that triggers a value change ─────────────────────────

await set(state, "root", 7);
await runCycle(state, "after-set");

console.log("\n─── stats_cycles (after cycle 2) ───");
console.log(get(state, STATS_CYCLES));

console.log("\n─── stats_channels (no channels bound here, expected empty) ───");
console.log(get(state, STATS_CHANNELS));

// ── compareRuntimeProfile: live env vs the frozen runtime ──────────────────

console.log("\n─── compareRuntimeProfile ───");
console.log(compareRuntimeProfile(state));

// ── Dehydrate: stats_* should NOT appear; config_performance.enabled
//    should reset to false; config_environment should round-trip. ──────────

const segments = dehydrate(state) as Segment[];
const allCels = segments.flatMap(s => s.cels);
const statsCels = allCels.filter(c => c.segment === "stats");
const configCels = allCels.filter(c => c.segment === "config");

console.log("\n─── dehydrate (filtered to config + stats) ───");
console.log(`  stats_* cels in dehydrate: ${statsCels.length} (expected 0)`);
console.log(`  config cels in dehydrate : ${configCels.length}`);
for (const c of configCels) {
  console.log(`    ${c.key}: ${JSON.stringify(c.v)}`);
}

// ── Reset stats ────────────────────────────────────────────────────────────

resetStats(state);
console.log("\n─── stats_cycles (after resetStats) ───");
console.log(get(state, STATS_CYCLES));   // null
console.log("\n─── stats_functions (after resetStats) ───");
console.log(get(state, STATS_FUNCTIONS));
console.log("\n─── config_environment (after resetStats — should be untouched) ───");
console.log(get(state, CONFIG_ENVIRONMENT));

console.log("\n[perf-tracking-demo] done.");
