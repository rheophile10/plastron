// ============================================================================
// life.react.ts — Conway's Life via per-cell useState + useEffect.
//
// Architecture:
//   Two Uint8Array grids of length N*N: `read` and `write`. The parent
//   component decides which is which based on the generation parity.
//   Each <Cell> reads neighbor values from `read` and writes its own
//   slot in `write` during a useEffect keyed on the generation counter.
//   When all cells' effects have flushed for a given generation, the
//   parent swaps `read`/`write` for the next tick.
//
// Per-cell useState holds the cell's own value (so the per-cell hook
// model the user asked for is honored), but the authoritative state
// lives in the typed-array grids — that's how cells see each other
// without prop-drilling N² values down a tree.
//
// One tick: bump generation → all N² cells re-render → all N² effects
// fire → await act() drain → swap grids.
//
// Throughput: generations / sec.
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

interface CellProps {
  x: number;
  y: number;
  n: number;
  read: Uint8Array;
  write: Uint8Array;
  generation: number;
}

const Cell: React.FC<CellProps> = ({ x, y, n, read, write, generation }) => {
  const [value, setValue] = React.useState<number>(read[x * n + y]!);
  React.useEffect(() => {
    let count = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        count += read[wrap(x + dx, n) * n + wrap(y + dy, n)]!;
      }
    }
    const self = read[x * n + y]!;
    const next = count === 3 || (count === 2 && self === 1) ? 1 : 0;
    write[x * n + y] = next;
    if (next !== value) setValue(next);
    // `generation` is the only dep we actually want to fire on — the
    // grids themselves are stable refs that we swap behind React's back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);
  return null;
};

interface GridProps {
  n: number;
  read: Uint8Array;
  write: Uint8Array;
  generation: number;
}

const Grid: React.FC<GridProps> = ({ n, read, write, generation }) => {
  const cells: React.ReactElement[] = [];
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      cells.push(
        React.createElement(Cell, {
          key: `${x},${y}`,
          x, y, n, read, write, generation,
        }),
      );
    }
  }
  return React.createElement(React.Fragment, null, ...cells);
};

interface Setup {
  renderer: TestRenderer.ReactTestRenderer;
  n: number;
  gridA: Uint8Array;
  gridB: Uint8Array;
  generation: { v: number };
}

const setupFor = async (n: number): Promise<Setup> => {
  const rand = rng(P.shared.seed);
  const gridA = new Uint8Array(n * n);
  const gridB = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) gridA[i] = rand() < P.shared.initialDensity ? 1 : 0;
  const generation = { v: 0 };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(Grid, { n, read: gridA, write: gridB, generation: generation.v }),
    );
  });
  // Drain initial effects.
  await act(async () => { /* flush */ });
  return { renderer, n, gridA, gridB, generation };
};

const tick = async (s: Setup): Promise<void> => {
  s.generation.v += 1;
  const evenGen = s.generation.v % 2 === 0;
  const read = evenGen ? s.gridB : s.gridA;
  const write = evenGen ? s.gridA : s.gridB;
  await act(async () => {
    s.renderer.update(
      React.createElement(Grid, { n: s.n, read, write, generation: s.generation.v }),
    );
  });
};

const main = async (): Promise<void> => {
  const allTimings: Record<string, unknown> = {};
  const p = profile.start({ label: "life-react" });

  let totalOps = 0;
  const sizes = P.react.sizes;
  for (const n of sizes) {
    process.stderr.write(`  life-react n=${n}×${n} (${n * n} cels)... `);
    const stats = await bench(
      () => setupFor(n),
      tick,
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
    meta: { sizes: [...sizes], perSizeTimings: allTimings, cellsPerGen: sizes.map((n) => n * n) },
  });
  profile.emit(report);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
