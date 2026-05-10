# plastron benchmarks

Replaces estimates in `notes/plastron-vs-excel.md` (gitignored — local working doc) with real measurements.

## Running

```sh
cd bench
npm install
npm run cascade        # cascade time vs graph shape × size
npm run memory         # per-cel heap cost — best with --expose-gc:
node --expose-gc --import tsx src/memory-per-cel.ts
npm run all            # everything
```

Each run writes structured JSON to `bench/results/`. Results are gitignored — they're per-machine.

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
