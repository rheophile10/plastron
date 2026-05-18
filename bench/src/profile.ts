// ============================================================================
// profile.ts — shared internal profiling lib for bench subprocesses.
//
// Every bench script imports this. It captures the things only the
// running process can see — GC pauses, V8 heap stats, monotonic
// resourceUsage — while the parent runner.ts captures external views
// (/usr/bin/time -v, /proc/<pid>/status polling, perf stat).
//
// Pattern inside a bench:
//
//   import { profile } from "./profile.js";
//   const p = profile.start({ pollMs: 50, label: "amort-1000" });
//   // ... measured workload ...
//   const report = await p.stop({ timings: stats });
//   process.stdout.write(`__BENCH_JSON__${JSON.stringify(report)}\n`);
//
// The `__BENCH_JSON__` sentinel is what runner.ts greps for in child
// stdout. Any other stdout (progress prints, warnings) is forwarded
// untouched so benches can stay chatty.
// ============================================================================

import * as v8 from "node:v8";
import { PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import type { Stats } from "./harness.js";

// ── Snapshot shapes ─────────────────────────────────────────────────────────

export interface ResourceSnapshot {
  /** RSS in bytes (process.memoryUsage). */
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  /** Max RSS observed by getrusage. On linux/darwin this is in KB,
   *  normalized to bytes here. */
  maxRssBytes: number;
  /** User CPU time in microseconds. */
  userCpuUs: number;
  /** System CPU time in microseconds. */
  systemCpuUs: number;
  voluntaryCtxSwitches: number;
  involuntaryCtxSwitches: number;
  majorPageFaults: number;
  minorPageFaults: number;
  fsRead: number;
  fsWrite: number;
  /** Monotonic wall-time in ns since process start. */
  monoNs: number;
}

export interface HeapStats {
  heapSizeLimit: number;
  totalPhysicalSize: number;
  totalAvailableSize: number;
  mallocedMemory: number;
  peakMallocedMemory: number;
  numberOfNativeContexts: number;
  numberOfDetachedContexts: number;
}

export interface HeapSpace {
  name: string;
  size: number;
  used: number;
  available: number;
  physical: number;
}

export interface GcEvent {
  /** "scavenge" | "mark-sweep-compact" | "incremental" | "process-weak-callbacks" | "all" */
  kind: string;
  durationMs: number;
  startTime: number;
}

export interface GcSummary {
  count: number;
  totalPauseMs: number;
  maxPauseMs: number;
  byKind: Record<string, { count: number; totalPauseMs: number; maxPauseMs: number }>;
}

export interface MemorySample {
  tMs: number;          // ms since profile.start()
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
}

export interface ProfileReport {
  label: string;
  /** Wall-time of the measured section in ms (mono-clock based). */
  wallMs: number;
  /** External CPU time delta (userCpuUs + systemCpuUs) in microseconds. */
  cpuUserDeltaUs: number;
  cpuSystemDeltaUs: number;
  startSnapshot: ResourceSnapshot;
  endSnapshot: ResourceSnapshot;
  /** end - start, computed by stop(). Convenience for downstream. */
  delta: {
    rssBytes: number;
    heapUsedBytes: number;
    maxRssBytes: number;
    voluntaryCtxSwitches: number;
    involuntaryCtxSwitches: number;
    majorPageFaults: number;
    minorPageFaults: number;
  };
  heapStart: HeapStats;
  heapEnd: HeapStats;
  heapSpacesEnd: HeapSpace[];
  gc: GcSummary;
  memorySamples: MemorySample[];
  /** Per-op timing stats from the bench's inner loop (optional). */
  timings?: Stats;
  /** Throughput in ops/sec, if the bench supplied opCount. */
  throughput?: { opCount: number; opsPerSec: number };
  /** Free-form workload metadata: graph size, parameters, etc. */
  meta?: Record<string, unknown>;
}

// ── Internal helpers ────────────────────────────────────────────────────────

// resourceUsage().maxRSS is KB on linux/darwin and bytes on win32.
// Normalize to bytes for everyone.
const MAXRSS_SCALE = process.platform === "win32" ? 1 : 1024;

const snapshot = (): ResourceSnapshot => {
  const m = process.memoryUsage();
  const r = process.resourceUsage();
  return {
    rss: m.rss,
    heapTotal: m.heapTotal,
    heapUsed: m.heapUsed,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
    maxRssBytes: r.maxRSS * MAXRSS_SCALE,
    userCpuUs: r.userCPUTime,
    systemCpuUs: r.systemCPUTime,
    voluntaryCtxSwitches: r.voluntaryContextSwitches,
    involuntaryCtxSwitches: r.involuntaryContextSwitches,
    majorPageFaults: r.majorPageFault,
    minorPageFaults: r.minorPageFault,
    fsRead: r.fsRead,
    fsWrite: r.fsWrite,
    monoNs: Math.floor(performance.now() * 1_000_000),
  };
};

const heapStatsNow = (): HeapStats => {
  const h = v8.getHeapStatistics();
  return {
    heapSizeLimit: h.heap_size_limit,
    totalPhysicalSize: h.total_physical_size,
    totalAvailableSize: h.total_available_size,
    mallocedMemory: h.malloced_memory,
    peakMallocedMemory: h.peak_malloced_memory,
    numberOfNativeContexts: h.number_of_native_contexts,
    numberOfDetachedContexts: h.number_of_detached_contexts,
  };
};

const heapSpacesNow = (): HeapSpace[] =>
  v8.getHeapSpaceStatistics().map((s) => ({
    name: s.space_name,
    size: s.space_size,
    used: s.space_used_size,
    available: s.space_available_size,
    physical: s.physical_space_size,
  }));

// GC kind constants are stable across V8 for years. Avoid the
// deprecated `entry.kind` accessor (DEP0152) — read `entry.detail.kind`
// instead, and fall back to `entry.kind` for older Node versions.
const GC_KIND_NAMES: Record<number, string> = {
  1:  "scavenge",
  2:  "mark-sweep-compact",
  4:  "incremental",
  8:  "weak-callbacks",
  15: "all",
};

const gcKindName = (entry: PerformanceEntry): string => {
  const e = entry as PerformanceEntry & { kind?: number; detail?: { kind?: number } };
  const kind = e.detail?.kind ?? e.kind;
  if (typeof kind !== "number") return "unknown";
  return GC_KIND_NAMES[kind] ?? `kind-${kind}`;
};

// ── Public API ──────────────────────────────────────────────────────────────

export interface StartOpts {
  label: string;
  /** Sample memoryUsage every N ms. 0 disables. Default 50. */
  pollMs?: number;
  /** Capture GC events. Default true. */
  captureGc?: boolean;
}

export interface StopOpts {
  timings?: Stats;
  opCount?: number;
  meta?: Record<string, unknown>;
}

interface ActiveProfile {
  stop: (opts?: StopOpts) => ProfileReport;
}

const start = (opts: StartOpts): ActiveProfile => {
  const startSnapshot = snapshot();
  const heapStart = heapStatsNow();
  const t0 = performance.now();

  const gcEvents: GcEvent[] = [];
  let gcObs: PerformanceObserver | undefined;
  if (opts.captureGc !== false) {
    gcObs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        gcEvents.push({
          kind: gcKindName(entry),
          durationMs: entry.duration,
          startTime: entry.startTime,
        });
      }
    });
    gcObs.observe({ entryTypes: ["gc"], buffered: true });
  }

  const memorySamples: MemorySample[] = [];
  const pollMs = opts.pollMs ?? 50;
  let pollHandle: NodeJS.Timeout | undefined;
  if (pollMs > 0) {
    // unref so the timer doesn't keep the process alive past the bench
    pollHandle = setInterval(() => {
      const m = process.memoryUsage();
      memorySamples.push({
        tMs: performance.now() - t0,
        rss: m.rss,
        heapUsed: m.heapUsed,
        heapTotal: m.heapTotal,
        external: m.external,
      });
    }, pollMs);
    pollHandle.unref();
  }

  return {
    stop: (stopOpts?: StopOpts): ProfileReport => {
      if (pollHandle) clearInterval(pollHandle);
      if (gcObs) gcObs.disconnect();
      const endSnapshot = snapshot();
      const heapEnd = heapStatsNow();
      const heapSpacesEnd = heapSpacesNow();
      const wallMs = (endSnapshot.monoNs - startSnapshot.monoNs) / 1_000_000;

      // GC summary.
      const byKind: GcSummary["byKind"] = {};
      let totalPauseMs = 0;
      let maxPauseMs = 0;
      for (const ev of gcEvents) {
        totalPauseMs += ev.durationMs;
        if (ev.durationMs > maxPauseMs) maxPauseMs = ev.durationMs;
        const k = (byKind[ev.kind] ??= { count: 0, totalPauseMs: 0, maxPauseMs: 0 });
        k.count += 1;
        k.totalPauseMs += ev.durationMs;
        if (ev.durationMs > k.maxPauseMs) k.maxPauseMs = ev.durationMs;
      }
      const gc: GcSummary = {
        count: gcEvents.length,
        totalPauseMs,
        maxPauseMs,
        byKind,
      };

      const report: ProfileReport = {
        label: opts.label,
        wallMs,
        cpuUserDeltaUs: endSnapshot.userCpuUs - startSnapshot.userCpuUs,
        cpuSystemDeltaUs: endSnapshot.systemCpuUs - startSnapshot.systemCpuUs,
        startSnapshot,
        endSnapshot,
        delta: {
          rssBytes: endSnapshot.rss - startSnapshot.rss,
          heapUsedBytes: endSnapshot.heapUsed - startSnapshot.heapUsed,
          maxRssBytes: endSnapshot.maxRssBytes - startSnapshot.maxRssBytes,
          voluntaryCtxSwitches:
            endSnapshot.voluntaryCtxSwitches - startSnapshot.voluntaryCtxSwitches,
          involuntaryCtxSwitches:
            endSnapshot.involuntaryCtxSwitches - startSnapshot.involuntaryCtxSwitches,
          majorPageFaults: endSnapshot.majorPageFaults - startSnapshot.majorPageFaults,
          minorPageFaults: endSnapshot.minorPageFaults - startSnapshot.minorPageFaults,
        },
        heapStart,
        heapEnd,
        heapSpacesEnd,
        gc,
        memorySamples,
        timings: stopOpts?.timings,
        meta: stopOpts?.meta,
      };
      if (stopOpts?.opCount !== undefined && wallMs > 0) {
        report.throughput = {
          opCount: stopOpts.opCount,
          opsPerSec: (stopOpts.opCount / wallMs) * 1000,
        };
      }
      return report;
    },
  };
};

/** Sentinel the runner greps for on child stdout. */
export const REPORT_SENTINEL = "__BENCH_JSON__";

/** Convenience: emit the report on stdout in the format runner.ts expects. */
const emit = (report: ProfileReport): void => {
  process.stdout.write(`${REPORT_SENTINEL}${JSON.stringify(report)}\n`);
};

export const profile = { start, emit, REPORT_SENTINEL };
