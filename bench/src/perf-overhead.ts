// ============================================================================
// perf-overhead — measure the cost of the perf-tracking hot-path with
// tracking DISABLED. The acceptance criterion is "within 5% of the
// pre-change baseline." We run a fixed-shape graph for a fixed number
// of cycles in three modes:
//
//   • baseline-equivalent: tracking off, no perf-config cel mutation
//   • tracking-on:        tracking on, every cycle sampled
//   • tracking-on-sample: tracking on, sampleRate=1000 (1 in 1000)
//
// runCycle is the path that pays the most overhead — it reads the
// perf-config cel at entry. The fanOut shape gives us a wide level
// where fireCel runs many times per cycle.
// ============================================================================

import {
  bench, environment, printStats, writeResults,
} from "./harness.js";
import type { Fn, Segment, State } from "../../plastron/src/index.js";
import {
  CONFIG_PERFORMANCE, createInitialState,
} from "../../plastron/src/index.js";

const N = 1000;

const buildSegment = (n: number): Segment => {
  const cels = [];
  cels.push({ key: "root", v: 0, segment: "bench" });
  for (let i = 0; i < n; i++) {
    cels.push({ key: `c${i}`, segment: "bench", f: "(+ root 1)" });
  }
  return { key: "bench", cels };
};

const setupState = async (): Promise<{ state: State; runCycle: Fn }> => {
  const state = createInitialState();
  const hydrate = state.fns.get("hydrate") as Fn;
  const runCycle = state.fns.get("runCycle") as Fn;
  hydrate(state, [buildSegment(N)], [new Map()]);
  await runCycle(state);
  return { state, runCycle };
};

const enableTracking = (state: State, sampleRate = 1): void => {
  const cel = state.cels.get(CONFIG_PERFORMANCE)!;
  (cel.v as { enabled: boolean; sampleRate: number }).enabled = true;
  (cel.v as { enabled: boolean; sampleRate: number }).sampleRate = sampleRate;
};

const main = async (): Promise<void> => {
  const startedAt = new Date().toISOString();
  console.log(`perf-overhead — started ${startedAt}`);
  console.log(`  graph: fanOut N=${N}`);
  console.log();

  // Baseline — tracking disabled (default).
  const baseline = await bench(
    setupState,
    async ({ runCycle, state }) => { await runCycle(state); },
    { warmup: 100, iterations: 1000 },
  );
  printStats("disabled", baseline);

  // Tracking on, every cycle sampled.
  const trackingOn = await bench(
    async () => {
      const s = await setupState();
      enableTracking(s.state, 1);
      return s;
    },
    async ({ runCycle, state }) => { await runCycle(state); },
    { warmup: 100, iterations: 1000 },
  );
  printStats("on/sample=1", trackingOn);

  // Tracking on, sample 1 in 1000 — should approach baseline + a tiny
  // mod check on most cycles.
  const trackingSampled = await bench(
    async () => {
      const s = await setupState();
      enableTracking(s.state, 1000);
      return s;
    },
    async ({ runCycle, state }) => { await runCycle(state); },
    { warmup: 100, iterations: 1000 },
  );
  printStats("on/sample=1000", trackingSampled);

  const overhead = (trackingOn.p50 / baseline.p50 - 1) * 100;
  const sampledOverhead = (trackingSampled.p50 / baseline.p50 - 1) * 100;
  console.log();
  console.log(`  tracking-on overhead  : ${overhead.toFixed(1)}% (vs disabled p50)`);
  console.log(`  sampled (1/1000)      : ${sampledOverhead.toFixed(1)}% (vs disabled p50)`);

  const path = writeResults("perf-overhead", {
    bench: "perf-overhead",
    environment: environment(),
    startedAt,
    finishedAt: new Date().toISOString(),
    n: N,
    results: { baseline, trackingOn, trackingSampled, overheadPct: overhead },
  });
  console.log(`  results → ${path}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
