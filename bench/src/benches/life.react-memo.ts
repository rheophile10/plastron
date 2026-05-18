// ============================================================================
// life.react-memo.ts — idiomatic React Life.
//
// Single <Sheet> component:
//   • useState holds the grid as a Uint8Array.
//   • useEffect on [tick] advances one generation by computing the
//     next grid in one O(N²) loop and setState'ing it.
//
// One render + one effect per tick, no per-cell mounts. This is the
// "best case React" reference for the Life family.
// ============================================================================

import * as React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { bench } from "../harness.js";
import { profile } from "../profile.js";
import { params } from "./params.js";

const P = params.life;

const rng = (seed: number): (() => number) => {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

const wrap = (i: number, n: number): number => ((i % n) + n) % n;

const seedGrid = (n: number): Uint8Array => {
  const rand = rng(P.shared.seed);
  const g = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) g[i] = rand() < P.shared.initialDensity ? 1 : 0;
  return g;
};

const step = (prev: Uint8Array, n: number): Uint8Array => {
  const out = new Uint8Array(n * n);
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      let count = 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          count += prev[wrap(x + dx, n) * n + wrap(y + dy, n)]!;
        }
      }
      const self = prev[x * n + y]!;
      out[x * n + y] = count === 3 || (count === 2 && self === 1) ? 1 : 0;
    }
  }
  return out;
};

interface SheetProps {
  n: number;
  tick: number;
}

const Sheet: React.FC<SheetProps> = ({ n, tick }) => {
  const [grid, setGrid] = React.useState<Uint8Array>(() => seedGrid(n));
  React.useEffect(() => {
    if (tick === 0) return;
    setGrid((prev) => step(prev, n));
  }, [tick, n]);
  // Touch grid so React doesn't optimize the state away.
  void grid;
  return null;
};

interface Setup {
  renderer: TestRenderer.ReactTestRenderer;
  n: number;
  tickRef: { v: number };
}

const setupFor = async (n: number): Promise<Setup> => {
  const tickRef = { v: 0 };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Sheet, { n, tick: tickRef.v }));
  });
  await act(async () => { /* flush */ });
  return { renderer, n, tickRef };
};

const tick = async (s: Setup): Promise<void> => {
  s.tickRef.v += 1;
  await act(async () => {
    s.renderer.update(React.createElement(Sheet, { n: s.n, tick: s.tickRef.v }));
  });
};

const main = async (): Promise<void> => {
  const allTimings: Record<string, unknown> = {};
  const p = profile.start({ label: "life-react-memo" });

  let totalOps = 0;
  const sizes = P.reactMemo.sizes;
  for (const n of sizes) {
    process.stderr.write(`  life-memo n=${n}×${n} (${n * n} cells)... `);
    const stats = await bench(
      () => setupFor(n),
      tick,
      { warmup: P.reactMemo.warmup(n), iterations: P.reactMemo.iterations(n) },
    );
    allTimings[`n=${n}`] = stats;
    totalOps += stats.n;
    process.stderr.write(`p50=${(stats.p50 / 1_000_000).toFixed(2)}ms p99=${(stats.p99 / 1_000_000).toFixed(2)}ms\n`);
  }

  const headline = allTimings[`n=${sizes[sizes.length - 1]}`] as ReturnType<typeof bench> extends Promise<infer R> ? R : never;
  const report = p.stop({
    timings: headline,
    opCount: totalOps,
    meta: { sizes: [...sizes], perSizeTimings: allTimings, cellsPerGen: sizes.map((n) => n * n) },
  });
  profile.emit(report);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
