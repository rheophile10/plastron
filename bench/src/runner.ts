// ============================================================================
// runner.ts — parent CLI that spawns each bench as a subprocess and
// merges external + internal profiling views.
//
// External (this process):
//   • /usr/bin/time -v wraps the child → authoritative wall, user/sys
//     CPU, peak RSS, page faults, context switches.
//   • Async poll of /proc/<pid>/status → memory time series (VmRSS,
//     VmHWM, VmPeak). Independent of the child's own poll inside
//     profile.ts; cross-checks the internal view.
//   • Optional wrappers (--flamegraph via 0x, --perf-stat via perf
//     stat, --cpu-prof / --heap-snapshot via node flags).
//
// Internal (each child via profile.ts):
//   • resourceUsage / heap stats / GC events / memoryUsage samples /
//     per-iter timing percentiles — emitted as a single JSON blob on
//     stdout prefixed __BENCH_JSON__.
//
// The runner merges both views into one record per child and writes
// the aggregated run to bench/results/runner-<ts>.json.
//
// CLI:
//   tsx src/runner.ts                    # run everything
//   tsx src/runner.ts --filter amort     # only families matching substring
//   tsx src/runner.ts --only plastron    # skip react variants (or --only react)
//   tsx src/runner.ts --perf-stat        # wrap each child in perf stat
//   tsx src/runner.ts --cpu-prof         # write .cpuprofile per child
//   tsx src/runner.ts --heap-snapshot    # child writes v8.writeHeapSnapshot
//   tsx src/runner.ts --flamegraph       # wrap each child with 0x (must be installed)
//   tsx src/runner.ts --no-time          # skip /usr/bin/time wrap (e.g. on macOS)
//   tsx src/runner.ts --poll-ms 50       # external /proc poll interval
// ============================================================================

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST, type BenchFamily, type BenchVariant } from "./manifest.js";
import { REPORT_SENTINEL, type ProfileReport } from "./profile.js";

const here = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(here, "..");
const RESULTS_DIR = resolve(BENCH_ROOT, "results");
const PROFILES_DIR = resolve(RESULTS_DIR, "profiles");

// ── CLI parsing (tiny — avoid dep) ──────────────────────────────────────────

interface Cli {
  filter?: string;
  only?: "plastron" | "react" | "react-memo" | "plastron-onecel";
  perfStat: boolean;
  cpuProf: boolean;
  heapSnapshot: boolean;
  flamegraph: boolean;
  noTime: boolean;
  pollMs: number;
}

const parseCli = (argv: string[]): Cli => {
  const opts: Cli = {
    perfStat: false,
    cpuProf: false,
    heapSnapshot: false,
    flamegraph: false,
    noTime: false,
    pollMs: 50,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--filter":        opts.filter = argv[++i]; break;
      case "--only":          opts.only = argv[++i] as Cli["only"]; break;
      case "--perf-stat":     opts.perfStat = true; break;
      case "--cpu-prof":      opts.cpuProf = true; break;
      case "--heap-snapshot": opts.heapSnapshot = true; break;
      case "--flamegraph":    opts.flamegraph = true; break;
      case "--no-time":       opts.noTime = true; break;
      case "--poll-ms":       opts.pollMs = Number(argv[++i]); break;
      default:
        if (a.startsWith("--")) {
          console.error(`Unknown flag: ${a}`);
          process.exit(2);
        }
    }
  }
  return opts;
};

// ── External views ──────────────────────────────────────────────────────────

/** Parsed output of `/usr/bin/time -v`. Fields are best-effort: the
 *  GNU time format is human-prose, not machine-readable, so we regex
 *  for the lines we know. Missing lines (e.g. on macOS BSD time) leave
 *  the field undefined. */
export interface GnuTimeReport {
  wallSec?: number;
  userSec?: number;
  sysSec?: number;
  maxRssKb?: number;
  voluntaryCtx?: number;
  involuntaryCtx?: number;
  majorPageFaults?: number;
  minorPageFaults?: number;
  fsInputs?: number;
  fsOutputs?: number;
  pctCpu?: number;
  exitStatus?: number;
}

const parseHMS = (s: string): number => {
  // "0:00.42" → 0.42 s; "1:02:03" → 3723 s
  const parts = s.split(":").map(Number);
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return Number(s);
};

const parseGnuTime = (raw: string): GnuTimeReport => {
  const get = (re: RegExp): string | undefined => raw.match(re)?.[1]?.trim();
  const numF = (s?: string): number | undefined => s ? Number(s) : undefined;
  return {
    wallSec:          numF(get(/Elapsed \(wall clock\) time[^:]*:\s*([0-9:.]+)/))
                      ?? (get(/Elapsed \(wall clock\) time[^:]*:\s*([0-9:.]+)/)
                          ? parseHMS(get(/Elapsed \(wall clock\) time[^:]*:\s*([0-9:.]+)/)!)
                          : undefined),
    userSec:          numF(get(/User time \(seconds\):\s*([0-9.]+)/)),
    sysSec:           numF(get(/System time \(seconds\):\s*([0-9.]+)/)),
    maxRssKb:         numF(get(/Maximum resident set size \(kbytes\):\s*(\d+)/)),
    voluntaryCtx:     numF(get(/Voluntary context switches:\s*(\d+)/)),
    involuntaryCtx:   numF(get(/Involuntary context switches:\s*(\d+)/)),
    majorPageFaults:  numF(get(/Major \(requiring I\/O\) page faults:\s*(\d+)/)),
    minorPageFaults:  numF(get(/Minor \(reclaiming a frame\) page faults:\s*(\d+)/)),
    fsInputs:         numF(get(/File system inputs:\s*(\d+)/)),
    fsOutputs:        numF(get(/File system outputs:\s*(\d+)/)),
    pctCpu:           numF(get(/Percent of CPU this job got:\s*(\d+)/)),
    exitStatus:       numF(get(/Exit status:\s*(\d+)/)),
  };
};

/** Snapshot of relevant /proc/<pid>/status fields, in bytes. */
export interface ProcSample {
  tMs: number;
  vmRssBytes: number;
  vmHwmBytes: number;   // peak RSS so far
  vmPeakBytes: number;  // peak virtual size
  vmSizeBytes: number;
  threads: number;
}

const KB_FIELD = /^(\w+):\s+(\d+)\s+kB/gm;
const THREADS_FIELD = /^Threads:\s+(\d+)/m;

const readProcSample = (pid: number, tMs: number): ProcSample | null => {
  const path = `/proc/${pid}/status`;
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null; // process exited between existsSync and read
  }
  const kb: Record<string, number> = {};
  for (const m of raw.matchAll(KB_FIELD)) {
    kb[m[1]!] = Number(m[2]) * 1024;
  }
  const threads = Number(raw.match(THREADS_FIELD)?.[1] ?? 1);
  return {
    tMs,
    vmRssBytes:  kb.VmRSS  ?? 0,
    vmHwmBytes:  kb.VmHWM  ?? 0,
    vmPeakBytes: kb.VmPeak ?? 0,
    vmSizeBytes: kb.VmSize ?? 0,
    threads,
  };
};

// ── Spawn a single bench ────────────────────────────────────────────────────

export interface BenchRun {
  family: string;
  variant: string;
  script: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Wall-clock from spawn to exit, in ms. */
  wallMs: number;
  /** /usr/bin/time -v report if available. */
  external?: GnuTimeReport;
  /** /proc/<pid>/status samples taken by the parent. */
  procSamples: ProcSample[];
  /** Peak VmRSS observed across procSamples, in bytes. */
  procPeakRssBytes: number;
  /** JSON report emitted by the child via profile.emit. */
  internal?: ProfileReport;
  /** Path to a saved .cpuprofile / .heapsnapshot if requested. */
  artifacts?: string[];
  /** stderr captured (truncated to 8KB to keep output sane). */
  stderr: string;
}

const truncate = (s: string, max = 8192): string =>
  s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} bytes]` : s;

// Build the argv for spawning a single variant. We layer wrappers from
// outside-in: /usr/bin/time → perf stat → 0x → node → tsx target.
interface SpawnPlan {
  cmd: string;
  args: string[];
  /** Path to GNU time's -o file (we read it after exit). undefined if --no-time. */
  timeOutPath?: string;
  /** Extra child env (passed via spawn env merge). */
  env?: Record<string, string>;
  /** Paths to harvest as artifacts after exit. */
  artifactDirs: string[];
}

const planSpawn = (
  family: BenchFamily,
  variant: BenchVariant,
  cli: Cli,
): SpawnPlan => {
  // Innermost: tsx <script>
  const scriptPath = resolve(BENCH_ROOT, "src", variant.script);
  const nodeArgs: string[] = ["--expose-gc"];
  const artifactDirs: string[] = [];
  const profileDir = resolve(PROFILES_DIR, `${family.name}-${variant.label}`);

  if (cli.cpuProf) {
    mkdirSync(profileDir, { recursive: true });
    nodeArgs.push("--cpu-prof", "--cpu-prof-dir", profileDir);
    artifactDirs.push(profileDir);
  }
  if (cli.heapSnapshot) {
    mkdirSync(profileDir, { recursive: true });
    // Tell the bench to drop a heap snapshot via env.
    artifactDirs.push(profileDir);
  }

  // Invoke as: `node --expose-gc [...prof flags] --import tsx <script>`.
  // The `--import tsx` form is the documented way to load TypeScript
  // sources via the tsx loader without needing a separate wrapper.
  let cmd: string = process.execPath;
  let args: string[] = [...nodeArgs, "--import", "tsx", scriptPath, ...(family.args ?? [])];

  // Layer: 0x flame graph (outermost JS wrapper).
  if (cli.flamegraph) {
    mkdirSync(profileDir, { recursive: true });
    artifactDirs.push(profileDir);
    args = ["--output-dir", profileDir, "--", cmd, ...args];
    cmd = "0x";
  }

  // Layer: perf stat (outer process-level wrapper).
  let timeOutPath: string | undefined;
  if (cli.perfStat) {
    args = ["stat", "-d", "-d", "-d", cmd, ...args];
    cmd = "perf";
  }

  // Layer: /usr/bin/time -v (outermost). Writes verbose output to -o
  // file so we don't tangle with child stderr.
  if (!cli.noTime && existsSync("/usr/bin/time")) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    timeOutPath = resolve(RESULTS_DIR, `.time-${family.name}-${variant.label}-${process.pid}.txt`);
    args = ["-v", "-o", timeOutPath, cmd, ...args];
    cmd = "/usr/bin/time";
  }

  return {
    cmd,
    args,
    timeOutPath,
    env: cli.heapSnapshot ? { BENCH_HEAP_SNAPSHOT_DIR: profileDir } : undefined,
    artifactDirs,
  };
};

const runOne = async (
  family: BenchFamily,
  variant: BenchVariant,
  cli: Cli,
): Promise<BenchRun> => {
  const plan = planSpawn(family, variant, cli);
  const t0 = performance.now();

  return new Promise<BenchRun>((resolveRun) => {
    const child = spawn(plan.cmd, plan.args, {
      cwd: BENCH_ROOT,
      env: { ...process.env, ...plan.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => stdoutChunks.push(b));
    child.stderr.on("data", (b: Buffer) => stderrChunks.push(b));

    // Forward live progress to our own terminal so the user sees motion.
    child.stdout.on("data", (b: Buffer) => process.stdout.write(b));
    child.stderr.on("data", (b: Buffer) => process.stderr.write(b));

    // /proc polling. Only Linux. When wrapped in /usr/bin/time or
    // perf stat, child.pid is the wrapper — the real Node process is
    // a descendant. We walk /proc/<pid>/task/<pid>/children one level
    // each poll to find the deepest descendant and sample that. (The
    // wrapper is tiny; what we actually care about is the Node child.)
    const procSamples: ProcSample[] = [];
    let procPeak = 0;
    let poll: NodeJS.Timeout | undefined;
    if (process.platform === "linux" && child.pid && cli.pollMs > 0) {
      const resolveLeafPid = (rootPid: number): number => {
        let pid = rootPid;
        for (let depth = 0; depth < 4; depth++) {
          const childrenPath = `/proc/${pid}/task/${pid}/children`;
          if (!existsSync(childrenPath)) return pid;
          let raw: string;
          try { raw = readFileSync(childrenPath, "utf8").trim(); }
          catch { return pid; }
          if (!raw) return pid;
          const first = Number(raw.split(/\s+/)[0]);
          if (!Number.isFinite(first)) return pid;
          pid = first;
        }
        return pid;
      };
      poll = setInterval(() => {
        const leaf = resolveLeafPid(child.pid!);
        const s = readProcSample(leaf, performance.now() - t0);
        if (s) {
          procSamples.push(s);
          if (s.vmRssBytes > procPeak) procPeak = s.vmRssBytes;
        }
      }, cli.pollMs);
      poll.unref();
    }

    child.on("exit", (code, signal) => {
      if (poll) clearInterval(poll);
      const wallMs = performance.now() - t0;

      const stdoutStr = Buffer.concat(stdoutChunks).toString("utf8");
      const stderrStr = Buffer.concat(stderrChunks).toString("utf8");

      // Parse internal JSON report from the sentinel line.
      let internal: ProfileReport | undefined;
      const sentinelIdx = stdoutStr.lastIndexOf(REPORT_SENTINEL);
      if (sentinelIdx !== -1) {
        const nlIdx = stdoutStr.indexOf("\n", sentinelIdx);
        const jsonStr = stdoutStr.slice(
          sentinelIdx + REPORT_SENTINEL.length,
          nlIdx === -1 ? undefined : nlIdx,
        );
        try {
          internal = JSON.parse(jsonStr) as ProfileReport;
        } catch (err) {
          console.error(`  [${family.name}/${variant.label}] failed to parse internal JSON: ${(err as Error).message}`);
        }
      }

      // Parse /usr/bin/time -v output if available.
      let external: GnuTimeReport | undefined;
      if (plan.timeOutPath && existsSync(plan.timeOutPath)) {
        try {
          external = parseGnuTime(readFileSync(plan.timeOutPath, "utf8"));
        } catch (err) {
          console.error(`  [${family.name}/${variant.label}] failed to parse /usr/bin/time output: ${(err as Error).message}`);
        }
      }

      resolveRun({
        family: family.name,
        variant: variant.label,
        script: variant.script,
        exitCode: code,
        signal,
        wallMs,
        external,
        procSamples,
        procPeakRssBytes: procPeak,
        internal,
        artifacts: plan.artifactDirs.length ? plan.artifactDirs : undefined,
        stderr: truncate(stderrStr),
      });
    });
  });
};

// ── Reporting ────────────────────────────────────────────────────────────────

const fmtBytes = (b: number): string => {
  if (Math.abs(b) >= 1 << 30) return `${(b / (1 << 30)).toFixed(2)} GB`;
  if (Math.abs(b) >= 1 << 20) return `${(b / (1 << 20)).toFixed(2)} MB`;
  if (Math.abs(b) >= 1 << 10) return `${(b / (1 << 10)).toFixed(2)} KB`;
  return `${b} B`;
};

const fmtMs = (ms: number): string => {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 1)    return `${ms.toFixed(2)} ms`;
  return `${(ms * 1000).toFixed(0)} μs`;
};

const fmtNs = (ns: number): string => {
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`;
  if (ns >= 1_000)     return `${(ns / 1_000).toFixed(2)} μs`;
  return `${ns} ns`;
};

const printRun = (run: BenchRun): void => {
  const status = run.exitCode === 0 ? "ok" : `FAIL(${run.exitCode ?? run.signal})`;
  console.log();
  console.log(`  ${run.family} / ${run.variant} — ${status}`);
  console.log(`    wall:       ${fmtMs(run.wallMs)}`);
  if (run.external) {
    const e = run.external;
    console.log(`    /usr/bin/time:`);
    if (e.wallSec     !== undefined) console.log(`      wall            ${(e.wallSec * 1000).toFixed(1)} ms`);
    if (e.userSec     !== undefined) console.log(`      user CPU        ${(e.userSec * 1000).toFixed(1)} ms`);
    if (e.sysSec      !== undefined) console.log(`      sys CPU         ${(e.sysSec * 1000).toFixed(1)} ms`);
    if (e.pctCpu      !== undefined) console.log(`      %CPU            ${e.pctCpu}%`);
    if (e.maxRssKb    !== undefined) console.log(`      peak RSS        ${fmtBytes(e.maxRssKb * 1024)}`);
    if (e.voluntaryCtx !== undefined) console.log(`      vol ctx sw      ${e.voluntaryCtx}`);
    if (e.involuntaryCtx !== undefined) console.log(`      invol ctx sw    ${e.involuntaryCtx}`);
    if (e.minorPageFaults !== undefined) console.log(`      minor faults    ${e.minorPageFaults}`);
    if (e.majorPageFaults !== undefined) console.log(`      major faults    ${e.majorPageFaults}`);
  }
  if (run.procPeakRssBytes > 0) {
    console.log(`    /proc poll:    peak VmRSS ${fmtBytes(run.procPeakRssBytes)} (${run.procSamples.length} samples)`);
  }
  if (run.internal) {
    const i = run.internal;
    console.log(`    internal:`);
    console.log(`      measured wall   ${fmtMs(i.wallMs)}`);
    console.log(`      delta RSS       ${fmtBytes(i.delta.rssBytes)}`);
    console.log(`      delta heapUsed  ${fmtBytes(i.delta.heapUsedBytes)}`);
    console.log(`      peak malloced   ${fmtBytes(i.heapEnd.peakMallocedMemory)}`);
    console.log(`      GC events       ${i.gc.count} (total pause ${i.gc.totalPauseMs.toFixed(2)} ms, max ${i.gc.maxPauseMs.toFixed(2)} ms)`);
    if (i.gc.count > 0) {
      const kinds = Object.entries(i.gc.byKind)
        .map(([k, v]) => `${k}=${v.count}/${v.totalPauseMs.toFixed(1)}ms`).join(", ");
      console.log(`      GC by kind      ${kinds}`);
    }
    if (i.timings) {
      const t = i.timings;
      console.log(`      per-op p50      ${fmtNs(t.p50)}`);
      console.log(`      per-op p95      ${fmtNs(t.p95)}`);
      console.log(`      per-op p99      ${fmtNs(t.p99)}`);
      console.log(`      per-op cv       ${(t.cv * 100).toFixed(1)}%`);
    }
    if (i.throughput) {
      console.log(`      throughput      ${i.throughput.opsPerSec.toFixed(0)} ops/sec (${i.throughput.opCount} ops)`);
    }
    if (i.meta && Object.keys(i.meta).length > 0) {
      console.log(`      meta            ${JSON.stringify(i.meta)}`);
    }
  }
  if (run.exitCode !== 0 && run.stderr) {
    console.log(`    stderr:\n${run.stderr.split("\n").map((l) => "      " + l).join("\n")}`);
  }
};

// Ordered list of variant labels we know how to render. Defines column
// order in the comparison table; unknown labels (e.g. future signal-lib
// variants) get appended at the end in the order they appear.
const KNOWN_LABEL_ORDER = ["plastron", "react", "react-memo", "plastron-onecel"];

const printFamilyComparison = (family: BenchFamily, runs: BenchRun[]): void => {
  if (runs.length < 2) return;
  const byVariant = new Map(runs.map((r) => [r.variant, r]));

  // Build column list in the declared order: only variants that ran
  // and produced internal reports.
  const cols: Array<{ label: string; run: BenchRun }> = [];
  for (const label of KNOWN_LABEL_ORDER) {
    const r = byVariant.get(label);
    if (r?.internal) cols.push({ label, run: r });
  }
  for (const [label, r] of byVariant) {
    if (KNOWN_LABEL_ORDER.includes(label)) continue;
    if (r.internal) cols.push({ label, run: r });
  }
  if (cols.length < 2) return;

  const ratio = (a: number, b: number): string =>
    b === 0 ? "—" : `${(a / b).toFixed(2)}×`;

  // Column width auto-fits the widest label (or its data row). 16 char
  // minimum keeps numbers readable.
  const colWidth = Math.max(16, ...cols.map((c) => c.label.length + 2));
  const col = (s: string): string => s.padStart(colWidth);
  const header = cols.map((c) => col(c.label)).join("  ");
  console.log();
  console.log(`  ${family.name} comparison`);
  console.log(`    ${"".padEnd(14)}${header}`);

  const row = <T>(label: string, get: (r: BenchRun) => T, fmt: (v: T) => string): void => {
    const cells = cols.map((c) => col(fmt(get(c.run)))).join("  ");
    console.log(`    ${label.padEnd(14)}${cells}`);
  };

  row("wall",        (r) => r.wallMs,             fmtMs);
  row("peak RSS",    (r) => r.procPeakRssBytes,   fmtBytes);
  row("GC count",    (r) => r.internal!.gc.count, (n) => String(n));
  row("GC pause ms", (r) => r.internal!.gc.totalPauseMs, (n) => n.toFixed(2));
  if (cols.every((c) => c.run.internal?.timings)) {
    row("per-op p50",  (r) => r.internal!.timings!.p50, fmtNs);
    row("per-op p99",  (r) => r.internal!.timings!.p99, fmtNs);
  }
  if (cols.every((c) => c.run.internal?.throughput)) {
    row("ops/sec",     (r) => r.internal!.throughput!.opsPerSec, (n) => n.toFixed(0));
  }

  // Ratios against the plastron baseline (the per-cel variant). Useful
  // for "what's the cost of each model relative to naive plastron?"
  const baseline = cols.find((c) => c.label === "plastron");
  if (baseline?.run.internal?.timings) {
    const lines: string[] = [];
    for (const c of cols) {
      if (c.label === "plastron" || !c.run.internal?.timings) continue;
      lines.push(`${c.label}/plastron p50 = ${ratio(c.run.internal.timings.p50, baseline.run.internal.timings.p50)}`);
    }
    if (lines.length) console.log(`    ratios:       ${lines.join(", ")}`);
  }
};

// ── Main ────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  const cli = parseCli(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  console.log(`plastron bench runner — ${startedAt}`);
  console.log(`  options: ${JSON.stringify(cli)}`);
  console.log();

  mkdirSync(RESULTS_DIR, { recursive: true });

  const families = MANIFEST.filter((f) =>
    cli.filter ? f.name.includes(cli.filter) : true,
  );
  if (families.length === 0) {
    console.error(`No families match filter "${cli.filter}"`);
    process.exit(2);
  }

  const allRuns: Array<{ family: string; runs: BenchRun[] }> = [];
  for (const fam of families) {
    console.log(`==> ${fam.name}: ${fam.description}`);
    const runs: BenchRun[] = [];
    const variants: BenchVariant[] = [];
    const want = (label: string): boolean => cli.only === undefined || cli.only === label;
    if (fam.plastron       && want("plastron"))        variants.push(fam.plastron);
    if (fam.react          && want("react"))           variants.push(fam.react);
    if (fam.reactMemo      && want("react-memo"))      variants.push(fam.reactMemo);
    if (fam.plastronOneCel && want("plastron-onecel")) variants.push(fam.plastronOneCel);

    for (const v of variants) {
      const scriptPath = resolve(BENCH_ROOT, "src", v.script);
      if (!existsSync(scriptPath)) {
        console.log(`  ${fam.name} / ${v.label} — skip (missing script ${v.script})`);
        continue;
      }
      const run = await runOne(fam, v, cli);
      runs.push(run);
      printRun(run);
    }
    printFamilyComparison(fam, runs);
    allRuns.push({ family: fam.name, runs });
  }

  // Write aggregated JSON.
  const stamp = startedAt.replace(/[:.]/g, "-");
  const outPath = resolve(RESULTS_DIR, `runner-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify({
    startedAt,
    finishedAt: new Date().toISOString(),
    cli,
    runs: allRuns,
  }, null, 2));
  console.log();
  console.log(`  results → ${outPath}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
