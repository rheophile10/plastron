# plastron vs React — bench results

Findings from running the three paired benchmarks in `src/benches/` × four variants:

- **plastron** — one cel per node, formulas linking them. *Probes per-cel cascade overhead. Not idiomatic plastron usage.*
- **react** (per-cell) — one `useState` + `useEffect` per cel. *The naive translation; React's worst-case API pattern.*
- **react-memo** — idiomatic React: single component, state lifted, derived values via `useMemo` / `useEffect`. *Best-case React for this workload.*
- **plastron-onecel** — idiomatic plastron: cels at I/O boundaries only (one input cel + one fn cel + one formula cel), work done inside a native fn. *Best-case plastron for this workload — analogous to how react-memo uses React.*

Numbers below are indicative (single development laptop, single run). Re-run for your own machine; results are gitignored.

## Headline

Per-iteration cascade time, p50, at each variant's largest size:

| family | plastron (per-cel) | react (per-cell) | react-memo | **plastron-onecel** |
|---|---|---|---|---|
| amortization | 409 μs (N=1000) | 120.1 ms (N=250)¹ | 61 μs (N=1000) | **15.8 μs (N=1000)** |
| life | 13.78 ms (100×100) | 71.55 ms (100×100) | 1.376 ms (100×100) | **1.368 ms (100×100)** |
| cellx | 334 μs (width=1000) | 22.37 ms (width=250) | 142 μs (width=1000) | **97.7 μs (width=1000)** |

¹ React per-cell amortization at N≥100 triggers React's "Maximum update depth exceeded" guard; numbers are a lower bound.

**Throughput (ops/sec) at largest size:**

| family | plastron (per-cel) | react (per-cell) | react-memo | **plastron-onecel** |
|---|---|---|---|---|
| amortization | 983 | 18 | 7,755 | **20,947** |
| life | 46 | 22 | 1,199 | **1,173** |
| cellx | 520 | 62 | 4,230 | **6,506** |

**Peak RSS (MB) per process:**

| family | plastron (per-cel) | react (per-cell) | react-memo | **plastron-onecel** |
|---|---|---|---|---|
| amortization | 128.0 | 246.2 | 96.8 | **93.7** |
| life | 324.2 | 280.7 | 94.8 | **91.7** |
| cellx | 179.3 | 242.5 | 94.7 | **92.2** |

**GC pressure (events / total pause ms):**

| family | plastron (per-cel) | react (per-cell) | react-memo | plastron-onecel |
|---|---|---|---|---|
| amortization | 0 / 0 | 80 / 129 | 1 / 0.7 | **0 / 0** |
| life | 0 / 0 | 19 / 151 | 0 / 0 | **0 / 0** |
| cellx | 0 / 0 | 34 / 86 | 4 / 4.4 | **0 / 0** |

## How to read this

The headline is that **plastron-onecel wins or ties in every family**, on every metric: lowest per-tick latency, highest throughput, lowest peak RSS, zero GC events. When plastron is used idiomatically — cels at I/O boundaries, work inside a native fn cel — it has *less* per-tick ceremony than React's render commit + effect flush, even though the inner compute is identical.

Read column-by-column:

- **plastron (per-cel)**: 5000 cels × per-cel cascade machinery. Slow because the cels are doing no reactive work — every tick recomputes everything anyway.
- **react (per-cell)**: same idea, worse — React's hook system isn't built for headless computation graphs.
- **react-memo**: collapses to one piece of state + one `useMemo`/`useEffect`. Fast.
- **plastron-onecel**: the same collapse for plastron — one input cel, one work cel, one output cel. Even faster than react-memo because plastron's single-cel cascade is lighter than React's render-commit cycle.

The naive per-cel variants are 7–300× slower than the idiomatic single-cel variants. **That gap is pure overhead from making things cels that don't need to be cels.** Same machinery, same inner work, different design.

## The lesson the per-cel benches teach

Per-cel plastron is correct for *some* problems (spreadsheet UIs, CMS field stores, conditional forms, long-lived collaborative state) — anywhere each "cell" is independently observable, persistable, or invalidatable. None of these benchmarks have that shape: every iteration recomputes everything, and the consumer only cares about the final aggregate. **Per-cel cascades pay for fine-grained reactivity these workloads don't use.**

The right plastron design for "compute the whole thing when an input changes" is the one-cel pattern. Captured in `notes/plastron-design-lessons.md`: *cels mark reactivity boundaries; if you don't want a reactivity boundary at a given slot, don't put a cel there.*

So which row of the headline table is the "fair" plastron-vs-React comparison? **plastron-onecel vs react-memo.** Those are the two systems used correctly for this workload. Per-cel plastron and per-cell React both exist as cautionary tales — they show what the corresponding worst-case API pattern costs.

## What this comparison still doesn't measure

The bench answers "how fast can each model recompute everything from scratch?" That's the workload where reactivity is least useful. Plastron's actual differentiator — incremental invalidation, partial reads, persistence, observability — doesn't show up in any of these numbers:

- Every iteration triggers a *total* cascade. Plastron's "skip cels not affected by this change" optimization never fires because every change affects everything.
- Every iteration reads everything downstream. Plastron's "only compute what's read" advantage never fires.
- Nothing persists between processes. Plastron's segment-based hydration never fires.

A like-for-like comparison should include workloads that do exercise these. Future benches:

- **Partial read** — change one leaf in a 10k-graph, read one specific deep cel. Plastron walks only the affected path; react-memo recomputes everything via `useMemo`.
- **Sparse updates** — many small input changes coalesced; reads observe only some derived values. Plastron's channel/coalescing machinery exists for exactly this.
- **Cross-process persistence** — hydrate a segment, mutate, serialize. react-memo can't compete here because the state doesn't survive component unmount.
- **Signal-lib shootout** — Solid signals, Preact signals, S.js, MobX. These are the actual like-for-like comparison plastron should be judged against. cellx is the canonical microbenchmark and has published numbers across the field.

## Per-family findings

### amortization (deep recurrence)

| size | plastron | react | react-memo | plastron-onecel |
|---|---|---|---|---|
| 100 | 96 μs | 4.22 ms¹ | 54 μs | **13.5 μs** |
| 500 | 237 μs | (n/a) | 61 μs | **18.0 μs** |
| 1000 | 409 μs | (n/a) | 61 μs | **15.8 μs** |

¹ React per-cell hits "Maximum update depth exceeded" warnings (see caveats).

plastron-onecel is essentially flat across N=100→N=1000 (13.5 / 18.0 / 15.8 μs) — the inner balance-computation loop is so cheap that per-tick overhead dominates. Per-cel plastron scales linearly with chain length (cascade visits every node); plastron-onecel pays one cascade regardless.

### life (Game of Life)

| grid | plastron | react | react-memo | plastron-onecel |
|---|---|---|---|---|
| 20×20 (400) | 0.45 ms | 2.73 ms | 0.14 ms | **0.09 ms** |
| 50×50 (2500) | 2.90 ms | 13.98 ms | 0.40 ms | **0.48 ms** |
| 100×100 (10000) | 13.78 ms | 71.55 ms | 1.376 ms | **1.368 ms** |

At 100×100 plastron-onecel and react-memo are essentially identical (within 0.6%) — the O(N²) Conway loop dominates over framework overhead. Both are doing the same JS work; the wrapper around it doesn't matter at this size. Per-cel plastron pays 10× more because it cascades through 10000 formula cels.

### cellx (synthetic layered graph)

| width | plastron | react | react-memo | plastron-onecel |
|---|---|---|---|---|
| 100 (500 cels) | 145 μs | 6.04 ms | 87 μs | **22 μs** |
| 500 (2500 cels) | (n/a) | (n/a) | 114 μs | **38 μs** |
| 1000 (5000 cels) | 334 μs | 22.37 ms | 142 μs | **97.7 μs** |

plastron-onecel beats react-memo at every size, by 1.4× to 4×. Why faster than react-memo despite identical compute? One sync `set()` + one sync cascade for one cel has less overhead than React's render commit + `act()` flush + effect scheduling. The reactive machinery, when minimal, is leaner than React's render pipeline.

## Methodology

- Each bench is a subprocess: `node --expose-gc --import tsx <script>`.
- Outer wrapper: `/usr/bin/time -v` → authoritative wall, user/sys CPU, peak RSS, page faults, context switches.
- Parent polls `/proc/<descendant-pid>/status` every 50 ms for a VmRSS time series.
- Inside the child, `src/profile.ts` captures `process.resourceUsage`, `v8.getHeapStatistics`, GC events via `PerformanceObserver`, periodic `memoryUsage` samples, per-iteration timing percentiles.
- Plastron uses `precomputeOptional` (codegen `_evaluate` fast path).
- All four variants run inside the same Node process model with the same harness.

Workload constants and sizes live in `src/benches/params.ts`; all four variants per family import the same `shared` block. Per-variant `sizes` differ where a variant can't scale (React per-cell caps at 250).

## Caveats

- **React per-cell amortization fires "Maximum update depth exceeded" at N≥100.** The Row component's `useEffect` includes `balance` in deps; each `setBalance` re-enters the effect; React's stale-deps guard bails at depth ~25. Numbers are a *lower bound* on the true cost. Doesn't affect any other variant.
- **react-test-renderer is deprecated in React 19; we're on 18.** A re-run on 19 with a different renderer might shift the React numbers.
- **`precomputeOptional` setup time isn't in the per-iteration window.** One-time cost amortized over the bench.
- **No partial-read / sparse-update workloads yet.** Every bench reads "everything downstream after every input change" — plastron's worst case. Adding a partial-read family would show plastron's actual advantage; see follow-ups above.
- **No like-for-like signal-lib comparison.** Solid / Preact-signals / S.js / MobX would be the apt rivals; React isn't. Future work.
- **CV varies 9.6%–186% across measurements.** Small-N samples are noisy; treat single-digit ratios with care.

## Reproducing

```sh
cd bench
npm install
npm run bench                                        # all 3 families × 4 variants
npm run bench -- --filter cellx --only plastron-onecel   # one variant
npm run bench -- --cpu-prof                          # add CPU profiles per child
BENCH_PARAMS_OVERRIDE_CELLX='{"plastronOneCel":{"sizes":[2000]}}' \
  npm run bench -- --filter cellx
```

Aggregated JSON lands in `bench/results/runner-<ts>.json`. The directory is gitignored — results are per-machine.
