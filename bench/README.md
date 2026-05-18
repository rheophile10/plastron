# plastron benchmarks

Replaces estimates in `notes/plastron-vs-excel.md` (gitignored — local working doc) with real measurements.

## Running

```sh
cd bench
npm install
npm run cascade        # cascade time vs graph shape × size (in-process)
npm run memory         # per-cel heap cost — best with --expose-gc:
node --expose-gc --import tsx src/memory-per-cel.ts
npm run all            # cascade + memory

# Multi-bench runner (spawns each bench as its own subprocess, captures
# external /usr/bin/time + /proc poll + internal resourceUsage + GC):
npm run bench                          # all families × both variants
npm run bench -- --filter amort        # families matching substring
npm run bench -- --only plastron       # skip react variants
npm run bench -- --cpu-prof            # also drop .cpuprofile per child
npm run bench -- --heap-snapshot       # also dump heap snapshot at peak
npm run bench -- --perf-stat           # wrap each child in `perf stat`
npm run bench -- --flamegraph          # wrap each child in 0x (must be installed)
```

Each run writes structured JSON to `bench/results/`. Results are gitignored — they're per-machine.

## Bench families (`npm run bench`)

Pairs of `.plastron.ts` + `.react.ts` scripts under `src/benches/`. The parent
runner (`src/runner.ts`) discovers them via `src/manifest.ts`, spawns each as
its own `node --expose-gc --import tsx <script>` subprocess, and merges
external + internal profiling views into a comparison table.

| Family | What it stresses |
|---|---|
| `amortization` | Deep dependency chain (N-month sheet driven by rate/principal/term) — cascade propagation along a long chain plus fan-in aggregate. |
| `life` | Conway's Life on N×N toroidal grid — uniform fan-in-8 throughput; reports generations/sec. |
| `cellx` | Synthetic layered graph (1000-wide × 5 deep, fanIn 4) — canonical signal-lib microbenchmark. |

### Profiling stack

Each subprocess is layered (outermost → innermost):

1. `/usr/bin/time -v` — authoritative wall, user/sys CPU, peak RSS, page faults, context switches.
2. *(opt)* `perf stat -d -d -d` — HW counters (cycles, IPC, cache misses).
3. *(opt)* `0x` — interactive flame graph.
4. `node --expose-gc [--cpu-prof] [--heap-prof] --import tsx <script>`.
5. Inside the child, `src/profile.ts` captures: `process.resourceUsage()` snapshots, `v8.getHeapStatistics()` + per-space, `PerformanceObserver` GC events (count / total pause / max pause / by kind), periodic `process.memoryUsage()` samples, and per-iteration timing percentiles from `src/harness.ts`.
6. In parallel from the parent, `/proc/<descendant-pid>/status` polled every `--poll-ms` (default 50) for a VmRSS / VmHWM / VmPeak time series.

### Tuning bench parameters

A single `src/benches/params.ts` module holds sizes / iteration counts /
workload constants per family, with `shared` / `plastron` / `react` blocks
so each variant can scale to what's realistic for it.

Override at runtime without editing the file via env vars:

```sh
BENCH_PARAMS_OVERRIDE_AMORTIZATION='{"react":{"sizes":[20,50],"iterations":30}}' \
  npm run bench -- --filter amort
```

Scalar `iterations` / `warmup` overrides are auto-wrapped to constant
functions. Anything else shallow-merges into the variant block.

### Adding a new bench family

1. Write `src/benches/<name>.plastron.ts` and `src/benches/<name>.react.ts`. Each ends by emitting one `__BENCH_JSON__<json>` line on stdout via `profile.emit(report)`.
2. Add a `<name>` block to `src/benches/params.ts`.
3. Append an entry to `MANIFEST` in `src/manifest.ts`.
4. `npm run bench` picks it up automatically.

## Knobs

| Variable | Effect |
|---|---|
| `BENCH_NO_OPTIONAL=1` | `cascade-shape` skips the optional precompute pass; measures the medium path (cached `_inputEntries`, no `_evaluate`) instead of the fast path. |

## Benches

### `cascade-shape.ts`

Measures `set` + cascade time across three graph shapes:

- **linear** — `c0 → c1 → ... → cN`. Pure propagation; no parallelism.
- **fanOut** — root with N children. Tests within-level Promise.all.
- **fanIn** — N leaves with one sink. Tests gather cost.

Default sizes: `{10, 100, 1000, 10000}`. Linear is capped at 5000 because plastron's `buildDownstream` recurses (`precompute.ts:253`) and overflows V8's stack at chain depths ~10k. **Filing this as a real plastron bug:** make `buildDownstream` iterative.

### `memory-per-cel.ts`

Measures heap delta from instantiating N cels of various shapes:

- **value** — bare value cel (`{ key, v }`).
- **formula** — `cel.f = "(+ a 1)"`. Adds parsed AST + compiled fn + auto-wired inputMap.
- **lambda** — `cel.l = "add"` referencing a registered native fn + explicit inputMap.
- **formulaEvaluated** — formula cel after `precomputeOptional` runs (`_evaluate` closure resident).

Run with `--expose-gc` for stable numbers. Without it, prior-run garbage in the heap adds noise.

## Pending benches

Still to write:

- `formula-paths.bench.ts` — direct comparison of three execution paths per fire (codegen / AST-walk-with-cached-refs / fallback-with-live-lookup). All three exist in current `runCycle.ts:122-150`; the bench just needs to populate the right state to exercise each.
- `channel-coalescing.bench.ts` and `channel-saturation.bench.ts` — synthetic channel impls under varying write load. Independent of any pending kernel work.
- `optional-pass.bench.ts` — cascade speed before/after `precomputeOptional`. Already feasible since the essential pass invalidates per-cel caches.

## What we've measured (vs. what the doc estimated)

From a single run on this machine — re-run for your own numbers.

**Cascade time, `set` + cascade, single iteration, fast path (`_evaluate` populated):**

| Shape | 10 | 100 | 1000 | 10000 |
|---|---|---|---|---|
| linear | 40 μs | 65 μs | 845 μs | 2.65 ms (n=5000) |
| fanOut | 3 μs | 25 μs | 437 μs | 4.54 ms |
| fanIn | 1.4 μs | 3.75 μs | 42 μs | 380 μs |

Doc's estimate at 10k was ~10 ms. fanIn is 25× faster than the estimate; fanOut is 2× faster; linear (capped earlier) is on track.

**Per-cel memory:**

| Shape | bytes/cel @ 100k |
|---|---|
| value | 330 |
| formula | 1640 |
| lambda | 700 |
| formulaEvaluated | 1650 |

Doc's estimate was "hundreds of bytes." Value cels match; formula/lambda are higher because they carry parsed AST + inputMap + closure refs. Extrapolating to 1M cels: ~330 MB for pure values, ~1.6 GB for all-formula. Doc said "~hundreds of MB to ~1 GB" — formula side is actually heavier than the upper estimate.

## What's next

See `notes/plastron-vs-excel.md` (private) for the full proposed bench list. Ship the remaining three (`formula-paths`, `channel-coalescing`, `channel-saturation`) before writing any external comparison.
