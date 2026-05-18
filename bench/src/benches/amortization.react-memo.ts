// ============================================================================
// amortization.react-memo.ts — idiomatic React amortization sheet.
//
// One <Sheet> component. Inputs (rate, principal, payment, term) are
// passed as props. `balances` and `total_paid` are derived via
// useMemo, recomputed only when the inputs change. No per-row mounts,
// no nested cascades.
//
// This is the "best case React" reference for the amortization family:
// what idiomatic React looks like when you express the same workload
// without per-cell hooks. The bench should be much faster than
// amortization.react.ts and reach plastron's sizes (1000+) without
// drama.
// ============================================================================

import * as React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { bench } from "../harness.js";
import { profile } from "../profile.js";
import { params } from "./params.js";

const P = params.amortization;

interface SheetProps {
  rate: number;
  principal: number;
  payment: number;
  term: number;
}

const Sheet: React.FC<SheetProps> = ({ rate, principal, payment, term }) => {
  const balances = React.useMemo(() => {
    const out = new Float64Array(term + 1);
    out[0] = principal;
    for (let i = 1; i <= term; i++) {
      out[i] = out[i - 1]! * (1 + rate) - payment;
    }
    return out;
  }, [rate, principal, payment, term]);
  React.useMemo(() => {
    let s = 0;
    for (let i = 1; i <= term; i++) s += balances[i]!;
    return s;
  }, [balances, term]);
  return null;
};

interface RootProps {
  term: number;
  rateRef: { v: number };
  tick: number;
}

const Root: React.FC<RootProps> = ({ term, rateRef, tick }) => {
  const rate = rateRef.v + tick * 1e-9;
  return React.createElement(Sheet, {
    rate,
    principal: P.shared.principal,
    payment: P.shared.payment,
    term,
  });
};

interface Setup {
  renderer: TestRenderer.ReactTestRenderer;
  rateRef: { v: number };
  tickRef: { v: number };
  term: number;
}

const setupFor = async (n: number): Promise<Setup> => {
  const rateRef = { v: P.shared.monthlyRateInit };
  const tickRef = { v: 0 };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(Root, { term: n, rateRef, tick: tickRef.v }),
    );
  });
  await act(async () => { /* flush */ });
  return { renderer, rateRef, tickRef, term: n };
};

const tickOnce = async (s: Setup): Promise<void> => {
  s.tickRef.v += 1;
  await act(async () => {
    s.renderer.update(
      React.createElement(Root, { term: s.term, rateRef: s.rateRef, tick: s.tickRef.v }),
    );
  });
};

const main = async (): Promise<void> => {
  const allTimings: Record<string, unknown> = {};
  const p = profile.start({ label: "amortization-react-memo" });

  let totalOps = 0;
  const sizes = P.reactMemo.sizes;
  for (const n of sizes) {
    process.stderr.write(`  amort-memo n=${n}... `);
    const stats = await bench(
      () => setupFor(n),
      tickOnce,
      { warmup: P.reactMemo.warmup(n), iterations: P.reactMemo.iterations(n) },
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
