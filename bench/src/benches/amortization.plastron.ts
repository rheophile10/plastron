// ============================================================================
// amortization.plastron.ts — deep-chain financial sheet.
//
// Sheet layout:
//   monthlyRate  : value cel (the input we mutate to drive cascades)
//   payment      : value cel (loan payment per month; set once at hydrate)
//   balance_0    : value cel (initial principal)
//   balance_i    : formula cel `(- (* balance_{i-1} (+ 1 monthlyRate)) payment)`
//   total_paid   : formula cel `(+ balance_1 balance_2 ... balance_N)`
//
// What this stresses:
//   • Deep dependency chain of length N (cascade propagation cost).
//   • One wide fan-in aggregate at the end (gather cost).
//   • Single-cel mutation triggers the whole chain — exactly the
//     workload a reactive sheet system is built for.
//
// Sizes: 100, 500, 1000. plastron's buildDownstream recurses, so
// chains past ~5000 risk stack overflow (filed separately).
// ============================================================================

import { bench } from "../harness.js";
import { profile } from "../profile.js";
import { params } from "./params.js";
import type { Fn, Segment, State } from "../../../plastron/src/index.js";
import { createInitialState } from "../../../plastron/src/index.js";
import { precomputeOptional } from "../../../plastron/src/core/precompute.js";

const P = params.amortization;

const buildSegment = (n: number, principal: number): Segment => {
  const cels: Segment["cels"] = [
    { key: "monthlyRate", v: P.shared.monthlyRateInit, segment: "amort" },
    { key: "payment", v: P.shared.payment, segment: "amort" },
    { key: "balance_0", v: principal, segment: "amort" },
  ];
  for (let i = 1; i <= n; i++) {
    cels.push({
      key: `balance_${i}`,
      segment: "amort",
      // balance_i = balance_{i-1} * (1 + monthlyRate) - payment
      f: `(- (* balance_${i - 1} (+ 1 monthlyRate)) payment)`,
    });
  }
  // Fan-in aggregate over all balance rows. Big formula source string
  // but the codegen path handles it (~6KB at N=1000).
  const balanceRefs = Array.from({ length: n }, (_, i) => `balance_${i + 1}`).join(" ");
  cels.push({
    key: "total_paid",
    segment: "amort",
    f: `(+ ${balanceRefs})`,
  });
  return { key: "amort", cels };
};

interface Setup {
  state: State;
  set: Fn;
  rateCounter: { v: number };
}

const setup = async (n: number): Promise<Setup> => {
  const state = createInitialState();
  const hydrate = state.fns.get("hydrate") as Fn;
  const runCycle = state.fns.get("runCycle") as Fn;
  const set = state.fns.get("set") as Fn;
  hydrate(state, [buildSegment(n, P.shared.principal)], [new Map()]);
  await runCycle(state);
  await precomputeOptional(state);
  return { state, set, rateCounter: { v: P.shared.monthlyRateInit } };
};

const tick = async (s: Setup): Promise<void> => {
  // Bump the rate by a tiny epsilon each iteration — invalidates every
  // cel on the chain and forces a full cascade. The actual value
  // doesn't matter; only the change does.
  s.rateCounter.v += 1e-9;
  await s.set(s.state, "monthlyRate", s.rateCounter.v);
};

const main = async (): Promise<void> => {
  const allTimings: Record<string, unknown> = {};
  const p = profile.start({ label: "amortization-plastron" });

  let totalOps = 0;
  const sizes = P.plastron.sizes;
  for (const n of sizes) {
    process.stderr.write(`  amort n=${n}... `);
    const stats = await bench(
      () => setup(n),
      tick,
      { warmup: P.plastron.warmup(n), iterations: P.plastron.iterations(n) },
    );
    allTimings[`n=${n}`] = stats;
    totalOps += stats.n;
    process.stderr.write(`p50=${(stats.p50 / 1000).toFixed(1)}μs p99=${(stats.p99 / 1000).toFixed(1)}μs\n`);
  }

  // Use the largest-size timings as the "headline" for the runner's
  // comparison table — that's the most interesting cascade depth.
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
