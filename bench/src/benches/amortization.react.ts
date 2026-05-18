// ============================================================================
// amortization.react.ts — same workload as amortization.plastron.ts,
// but each "row" is a function component with useState + useEffect.
//
// Tree shape (linear nesting):
//   <Root rate>
//     <Row idx=0 prev=principal>
//       <Row idx=1 prev=balance_0>
//         ...
//         <Row idx=N-1 prev=balance_{N-2}/>
//
// Each Row holds its own balance via useState and recomputes via
// useEffect whenever its `prev` or the inherited `rate` changes.
// Changing `rate` at the top triggers a cascading wave of
// renders → effects → setStates → renders, all the way down. We use
// act() to flush every pending effect before recording the time.
//
// Sizes are smaller than the plastron variant because nested-component
// React with per-cell effects is O(N²) per cascade (each setBalance
// triggers a re-render of the sub-tree below). N=1000 is ~minutes per
// iteration — not actionable. We run 50/100/250 here; that's the
// point of the comparison anyway: plastron handles the same chain at
// a different complexity class.
// ============================================================================

import * as React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { bench } from "../harness.js";
import { profile } from "../profile.js";
import { params } from "./params.js";

const P = params.amortization;

// One row. Lives in the dep chain via its `prev` prop.
interface RowProps {
  idx: number;
  total: number;
  prev: number;
  rate: number;
  payment: number;
}

const Row: React.FC<RowProps> = ({ idx, total, prev, rate, payment }) => {
  const [balance, setBalance] = React.useState(prev);
  React.useEffect(() => {
    const next = prev * (1 + rate) - payment;
    if (next !== balance) setBalance(next);
  }, [prev, rate, payment, balance]);
  if (idx + 1 >= total) return null;
  return React.createElement(Row, {
    idx: idx + 1,
    total,
    prev: balance,
    rate,
    payment,
  });
};

interface RootProps {
  total: number;
  principal: number;
  payment: number;
  rateRef: { v: number };
  /** Bumped each iteration to force the rate prop to re-evaluate. */
  tick: number;
}

const Root: React.FC<RootProps> = ({ total, principal, payment, rateRef, tick }) => {
  // Read the latest rate at render time so each external tick bump
  // surfaces the new rate to the chain. (We can't use state here
  // because the test bench mutates rateRef from outside React.)
  const rate = rateRef.v + tick * 1e-9;
  return React.createElement(Row, {
    idx: 0,
    total,
    prev: principal,
    rate,
    payment,
  });
};

interface Setup {
  renderer: TestRenderer.ReactTestRenderer;
  rateRef: { v: number };
  tickRef: { v: number };
  total: number;
}

const setupFor = async (n: number): Promise<Setup> => {
  const rateRef = { v: P.shared.monthlyRateInit };
  const tickRef = { v: 0 };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(Root, {
        total: n,
        principal: P.shared.principal,
        payment: P.shared.payment,
        rateRef,
        tick: tickRef.v,
      }),
    );
  });
  // Flush the initial effect cascade so we're measuring a steady-state
  // update, not the first paint.
  await act(async () => {
    // empty body — act drains pending effects on flush
  });
  return { renderer, rateRef, tickRef, total: n };
};

const tickOnce = async (s: Setup): Promise<void> => {
  s.tickRef.v += 1;
  await act(async () => {
    s.renderer.update(
      React.createElement(Root, {
        total: s.total,
        principal: P.shared.principal,
        payment: P.shared.payment,
        rateRef: s.rateRef,
        tick: s.tickRef.v,
      }),
    );
  });
};

const main = async (): Promise<void> => {
  const allTimings: Record<string, unknown> = {};
  const p = profile.start({ label: "amortization-react" });

  let totalOps = 0;
  const sizes = P.react.sizes;
  for (const n of sizes) {
    process.stderr.write(`  amort-react n=${n}... `);
    const stats = await bench(
      () => setupFor(n),
      tickOnce,
      { warmup: P.react.warmup(n), iterations: P.react.iterations(n) },
    );
    allTimings[`n=${n}`] = stats;
    totalOps += stats.n;
    process.stderr.write(`p50=${(stats.p50 / 1_000_000).toFixed(2)}ms p99=${(stats.p99 / 1_000_000).toFixed(2)}ms\n`);
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
