// ============================================================================
// Bench harness — shared utilities for plastron benchmarks.
//
// Goals:
//   • Sub-microsecond timing via `performance.now()` (Node ≥ 16 has
//     monotonic high-res timing in milliseconds with sub-μs resolution).
//   • Percentile reporting (p50, p95, p99) — averages alone hide tail
//     latency that matters for cascades feeding 60Hz UIs.
//   • Warm-up loop separate from the measurement loop. The first few
//     fires are JIT-cold; we discard them.
//   • Optional explicit GC between trials when `--expose-gc` is set, so
//     memory benchmarks don't have prior trial garbage in the heap.
//   • Structured JSON output to bench/results/ for plotting.
//
// This module has zero plastron dependencies — benchmarks import what
// they need themselves.
// ============================================================================

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── Timing ───────────────────────────────────────────────────────────────────

/** High-res monotonic time in nanoseconds. `performance.now()` returns
 *  ms with sub-μs resolution; multiply for ns. The integer truncation
 *  is fine — we report percentiles in ns but plot in μs/ms. */
export const nowNs = (): number => Math.floor(performance.now() * 1_000_000);

/** Run `fn` once, return wall-clock duration in ns. */
export const time = <T>(fn: () => T | Promise<T>): Promise<{ result: T; ns: number }> => {
  const t0 = nowNs();
  const out = fn();
  if (out instanceof Promise) {
    return out.then((result) => ({ result, ns: nowNs() - t0 }));
  }
  return Promise.resolve({ result: out, ns: nowNs() - t0 });
};

// ── Statistics ───────────────────────────────────────────────────────────────

export interface Stats {
  n: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  /** Coefficient of variation (stddev / mean) — flags noisy runs. */
  cv: number;
}

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
};

export const stats = (samples: number[]): Stats => {
  if (samples.length === 0) {
    return { n: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0, cv: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  const variance = sorted.reduce((acc, x) => acc + (x - mean) ** 2, 0) / sorted.length;
  const stddev = Math.sqrt(variance);
  return {
    n: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    cv: mean === 0 ? 0 : stddev / mean,
  };
};

// ── Bench loops ──────────────────────────────────────────────────────────────

export interface BenchOpts {
  /** Iterations to discard before measurement. */
  warmup?: number;
  /** Iterations to measure. */
  iterations?: number;
  /** Force GC between iterations when --expose-gc is on. Default false
   *  (GC is expensive; only helpful for memory-sensitive benches). */
  gcBetween?: boolean;
}

const DEFAULT_OPTS: Required<BenchOpts> = {
  warmup: 50,
  iterations: 500,
  gcBetween: false,
};

const maybeGc = (gcBetween: boolean): void => {
  if (!gcBetween) return;
  // Available when Node is run with --expose-gc.
  const g = (globalThis as unknown as { gc?: () => void }).gc;
  if (g) g();
};

/** Run `setup` once to build state, then `fn(state)` `warmup + iterations`
 *  times. Returns timing stats over the measured slice. */
export const bench = async <S>(
  setup: () => Promise<S> | S,
  fn: (state: S) => Promise<unknown> | unknown,
  opts: BenchOpts = {},
): Promise<Stats> => {
  const o = { ...DEFAULT_OPTS, ...opts };
  const state = await setup();

  // Warm-up — discard timings; lets V8 optimize the hot fn.
  for (let i = 0; i < o.warmup; i++) {
    const r = fn(state);
    if (r instanceof Promise) await r;
  }

  const samples: number[] = new Array(o.iterations);
  for (let i = 0; i < o.iterations; i++) {
    maybeGc(o.gcBetween);
    const t0 = nowNs();
    const r = fn(state);
    if (r instanceof Promise) await r;
    samples[i] = nowNs() - t0;
  }
  return stats(samples);
};

// ── Memory measurement ───────────────────────────────────────────────────────

/** RSS + heap stats. The diff between two snapshots — under
 *  --expose-gc with a forced gc before each — gives the most stable
 *  estimate of "memory cost of this thing." */
export interface MemSnapshot {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export const memSnapshot = (): MemSnapshot => {
  const m = process.memoryUsage();
  return {
    rss: m.rss,
    heapTotal: m.heapTotal,
    heapUsed: m.heapUsed,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
  };
};

export const memDelta = (a: MemSnapshot, b: MemSnapshot): MemSnapshot => ({
  rss:          b.rss          - a.rss,
  heapTotal:    b.heapTotal    - a.heapTotal,
  heapUsed:     b.heapUsed     - a.heapUsed,
  external:     b.external     - a.external,
  arrayBuffers: b.arrayBuffers - a.arrayBuffers,
});

// ── Reporting ────────────────────────────────────────────────────────────────

/** Pretty-print a single stats row to stdout. */
export const printStats = (label: string, s: Stats): void => {
  const fmt = (ns: number): string => {
    if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`;
    if (ns >= 1_000)     return `${(ns / 1_000).toFixed(2)} μs`;
    return `${ns} ns`;
  };
  const cv = s.cv === 0 ? "—" : `${(s.cv * 100).toFixed(1)}%`;
  console.log(
    `    ${label.padEnd(14)} ` +
    `iters=${s.n.toString().padStart(4)}  ` +
    `p50=${fmt(s.p50).padStart(10)}  ` +
    `p95=${fmt(s.p95).padStart(10)}  ` +
    `p99=${fmt(s.p99).padStart(10)}  ` +
    `cv=${cv}`,
  );
};

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(here, "..", "results");

/** Persist a bench's structured results to bench/results/<name>-<timestamp>.json. */
export const writeResults = (name: string, payload: unknown): string => {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = resolve(RESULTS_DIR, `${name}-${stamp}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
};

// ── Environment summary ──────────────────────────────────────────────────────

export const environment = (): Record<string, unknown> => ({
  node:      process.version,
  platform:  process.platform,
  arch:      process.arch,
  v8:        process.versions.v8,
  cpuModel:  // best-effort — may be absent on some platforms
    (() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require("node:os").cpus()?.[0]?.model;
      } catch {
        return undefined;
      }
    })(),
  exposeGc: typeof (globalThis as unknown as { gc?: () => void }).gc === "function",
  capturedAt: new Date().toISOString(),
});
