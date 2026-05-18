// ============================================================================
// amortization.plastron-onecel.ts — "plastron used correctly" for the
// amortization workload.
//
// Cels are at the I/O boundary only:
//   • monthlyRate — value cel (the input we mutate).
//   • compute     — function-value cel: closes over (principal, payment,
//                   term) and, given a rate, returns the full Float64Array
//                   of balances in one O(N) loop.
//   • result      — formula cel `(compute monthlyRate)`. Plastron fires
//                   this one cascade per rate change; the work happens
//                   inside the native fn.
//
// This is what amortization.plastron.ts *should* look like if the goal
// is throughput, not per-row observability. The per-cel version exists
// to probe cascade-machinery overhead; this version exists to show
// what plastron's actual ceiling looks like.
// ============================================================================

import { bench } from "../harness.js";
import { profile } from "../profile.js";
import { params } from "./params.js";
import type { Fn, Segment, State } from "../../../plastron/src/index.js";
import { createInitialState } from "../../../plastron/src/index.js";
import { precomputeOptional } from "../../../plastron/src/core/precompute.js";

const P = params.amortization;

const buildSegment = (n: number): Segment => {
  const principal = P.shared.principal;
  const payment = P.shared.payment;

  // compute(rate) — runs the whole amortization recurrence inline.
  // Closes over principal, payment, n. Returns the full balances array.
  const compute = (rate: unknown): Float64Array => {
    const r = Number(rate);
    const out = new Float64Array(n + 1);
    out[0] = principal;
    for (let i = 1; i <= n; i++) {
      out[i] = out[i - 1]! * (1 + r) - payment;
    }
    return out;
  };

  return {
    key: "amort",
    cels: [
      { key: "monthlyRate", segment: "amort", v: P.shared.monthlyRateInit },
      { key: "compute",     segment: "amort", v: compute },
      { key: "result",      segment: "amort", f: "(compute monthlyRate)" },
    ],
  };
};

interface Setup {
  state: State;
  set: Fn;
  rateCounter: { v: number };
}

const setupFor = async (n: number): Promise<Setup> => {
  const state = createInitialState();
  const hydrate = state.fns.get("hydrate") as Fn;
  const runCycle = state.fns.get("runCycle") as Fn;
  const set = state.fns.get("set") as Fn;
  hydrate(state, [buildSegment(n)], [new Map()]);
  await runCycle(state);
  await precomputeOptional(state);
  return { state, set, rateCounter: { v: P.shared.monthlyRateInit } };
};

const tick = async (s: Setup): Promise<void> => {
  s.rateCounter.v += 1e-9;
  await s.set(s.state, "monthlyRate", s.rateCounter.v);
};

const main = async (): Promise<void> => {
  const allTimings: Record<string, unknown> = {};
  const p = profile.start({ label: "amortization-plastron-onecel" });

  let totalOps = 0;
  const sizes = P.plastronOneCel.sizes;
  for (const n of sizes) {
    process.stderr.write(`  amort-onecel n=${n} (3 plastron cels, work inside native fn)... `);
    const stats = await bench(
      () => setupFor(n),
      tick,
      { warmup: P.plastronOneCel.warmup(n), iterations: P.plastronOneCel.iterations(n) },
    );
    allTimings[`n=${n}`] = stats;
    totalOps += stats.n;
    process.stderr.write(`p50=${(stats.p50 / 1000).toFixed(1)}μs p99=${(stats.p99 / 1000).toFixed(1)}μs\n`);
  }

  const headline = allTimings[`n=${sizes[sizes.length - 1]}`] as ReturnType<typeof bench> extends Promise<infer R> ? R : never;
  const report = p.stop({
    timings: headline,
    opCount: totalOps,
    meta: { sizes: [...sizes], perSizeTimings: allTimings },
  });
  profile.emit(report);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
