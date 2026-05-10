# plastron 🐢

A reactive computation kernel for TypeScript. Cels hold values or formulas; writing one fires a cascade that recomputes every downstream cel in topological order. Pluggable compilers (formula, Scheme, Python, WASM) plug new languages in at the cel boundary. Pluggable channels (DOM, IndexedDB, audit log, network) route changes to side-effect sinks. The whole graph round-trips through JSON segments.

## Where it sits

Plastron is a small reactive kernel, ~2.4 kloc of TypeScript. It's not a spreadsheet engine and it's not a UI framework. The closest neighbors:

| | plastron | HyperFormula | Solid / Preact signals |
|---|---|---|---|
| Shape | reactive DAG, JSON-serializable | headless spreadsheet engine | reactive primitive in a UI framework |
| Formula language | swappable (S-expr default; register Scheme, Python, WASM at any key) | Excel-compatible (~400 functions) | none — TypeScript expressions |
| Numeric storage | heterogeneous JS objects | packed column matrices | per-signal closures |
| Side-effect routing | declarative `cel.channel` → pluggable sinks | n/a (calc engine only) | `createEffect` |
| Bundle | tiny | large | tiny |
| License | MIT | GPLv3 / commercial | MIT |

If you want Excel-without-the-UI for numeric workloads, use HyperFormula. If you want fine-grained reactivity inside a UI framework, use Solid or signals. Plastron's niche is the middle: an embeddable reactive kernel where the formula language is yours to pick (or design), the side effects are declarative, and the graph itself is JSON you can ship over the wire.

## Lore

In Shang dynasty China (c. 1600–1046 BCE), diviners would take a freshly cleaned turtle plastron — the ventral shell — score it with grooves on the back, and apply a hot brand. The shell would crack along the grooves; the diviner would read the cracks as an answer to a question, then inscribe the question and answer on the same plastron in oracle-bone script. One artifact: the substrate, the query, the computation, and the record. About 200,000 plastrons and ox scapulae from this practice have been excavated; their inscriptions are among the earliest known forms of Chinese writing.

Three thousand years later, the same idea — a substrate where you write down a question, the substrate computes for you, and the answer is also written down on it — gets reinvented as the spreadsheet. VisiCalc (1979). Lotus 1-2-3 (1983, formulas in a binary container). Excel (1985, then everywhere). xlsx (2007, a zip of XML files: open format, locked engine). One artifact carries the question, the data, the computation, and the answer.

Plastron borrows the structure — substrate carries everything — without claiming to be a spreadsheet. The substrate is JSON segments. The engine is a few hundred lines of TypeScript. You bring the syntax for the formulas — the kernel only knows about cels, dependencies, waves, and channels.

— Background on the project's name: [`plastromancy.md`](plastromancy.md).

## Install

```sh
git clone https://github.com/rheophile10/plastron
cd plastron/plastron
npm install
npm run build
```

## Quick start

```ts
import type { Fn, Segment } from "plastron";
import { createInitialState } from "plastron";

const demo: Segment = {
  key: "demo",
  cels: [
    { key: "price", v: 100,                segment: "demo" },
    { key: "qty",   v: 3,                  segment: "demo" },
    { key: "total", f: "(* price qty)",    segment: "demo" },
  ],
};

const state    = createInitialState();
const hydrate  = state.fns.get("hydrate")!  as Fn;
const runCycle = state.fns.get("runCycle")! as Fn;
const get      = state.fns.get("get")!      as Fn;
const set      = state.fns.get("set")!      as Fn;

hydrate(state, [demo], []);
await runCycle(state);
console.log(get(state, "total"));    // 300

await set(state, "qty", 4);
console.log(get(state, "total"));    // 400 (cascade fired automatically)
```

The kernel exposes itself through `state.fns` — every operation (`get`, `set`, `batch`, `setCel`, `hydrate`, `runCycle`, `flush`, `drain`, `registerLambda`, …) is a fn in that map. Hosts replace any of them by passing a `Map<LambdaKey, Fn>` to `hydrate`. Built-ins are lock-protected via `state.fnMetadata`.

## Hydration

Segments are JSON-shaped bundles:

```ts
interface Segment {
  key: string;
  cels: DehydratedCel[];
  schemas?:        Record<SchemaKey, JSONSchema>;
  fnMetaData?:     Record<LambdaKey, LambdaMetadata>;
  schemaMetadata?: Record<SchemaKey, SchemaMetadata>;
  downstream?:     Record<Key, Key[]>;     // optional, see "Shipping precomputed closures"
  manifest?:       SegmentManifest;        // optional, see "Segment manifests"
}
```

`hydrate(state, segments, fns)` folds them into live State:

1. **Pull metadata.** Schemas (JSON Schema → live Zod), fnMetaData, schemaMetadata go into the corresponding State maps. Locks gate later replacements.
2. **Install user fns.** The `fns` parameter is a list of `Map<LambdaKey, Fn>` — user-supplied callables, including replacements for built-ins like the formula compiler at key `"f"`. Locked entries are skipped.
3. **Inflate cels.** Each `DehydratedCel` becomes a live `Cel`. If `cel.f` is set, the compiler at `state.fns.get(cel.l ?? "f")` runs against the source string; the result populates `cel._fn` (and optionally `cel._dispose`, `cel._buildEvaluate` — see _Non-essential optimization_ below).
4. **Materialize schema fns.** Cels with a `schema` get `_isChanged` and `_diffFn` resolved from the schema's metadata — change-detection and diff production live where they belong (on the schema), not on the cel.
5. **Precompute.** The DAG indexes get derived. See next section.
6. **Seed closure cache.** If any segment ships a `downstream` field, those entries pre-populate the lazy `downstream` cache so the consumer's first write to a baked key skips the BFS warm-up.

Dehydration is the inverse: walk live cels, write JSON, and (optionally) bake `downstream` closures for the keys the consumer will write at startup. Lossy where Zod schemas carry refinements, transforms, or brands — those don't survive the round-trip through JSON Schema.

## Precompute and Kahn's algorithm

Precompute walks the cel graph and produces a few indexes the cascade reads on every write. The structurally interesting one is **wave-level Kahn**.

Kahn's algorithm topologically sorts a DAG by repeatedly emitting nodes whose upstream dependencies have all been emitted. The level-aware variant emits each "ready frontier" as a group rather than flattening into a single list. Every cel in a level has all its in-wave upstream deps in earlier levels; cels in the same level share no transitive dep edge between them.

Per wave $w$:

```
members(w) = { cel : cel.wave = w }
upstreamOf(cel) = { ref ∈ inputMap : ref ∈ members(w) }
remaining ← members(w)
while remaining ≠ ∅:
    ready ← { cel ∈ remaining : upstreamOf(cel) ∩ remaining = ∅ }
    if ready = ∅: throw cycle
    levels.push(ready)
    remaining ← remaining \ ready
```

The result is a `Map<number, Key[][]>` from wave number to levels. Plus four companions:

| Index | Shape | Built when | Used by |
|---|---|---|---|
| `waveCascade` | `Map<wave, Key[][]>` | eager, every precompute | `runCascade`, the iteration order |
| `sortedWaves` | `number[]` | eager | outer loop in `runCascade` |
| `children` | `Map<Key, Set<Key>>` | eager, $O(E)$ | `affectedFor` (BFS source) |
| `downstream` | `Map<Key, Set<Key>>` | **lazy memo**, fills on first write | `set/batch` to scope the affected set |
| `dynamicCascade` | `Set<Key>` | eager, BFS per dynamic seed | volatile cels + their downstreams; always included |

`children` is reverse adjacency: for each upstream key, the cels that consume it. Built once per precompute in $O(V + E)$.

`downstream` is a lazy memoized closure cache, **not** built up front. The first `set(k)` BFSes from $k$ over `children` and stores the result; subsequent writes to the same $k$ hit the cache. Each essential precompute pass installs a fresh empty cache, so a topology change can't surface a stale closure.

Total precompute cost: $O(V + E)$. Per-write cost: $O(|\text{aff}(k)|)$ on first write to $k$ since the last topology change, $O(1)$ on subsequent writes (modulo the cascade itself).

Hydrate may pre-seed `downstream` from a segment's optional [`downstream` field](#shipping-precomputed-closures), so a consumer that immediately writes a known input key skips the BFS warm-up.

## Shipping precomputed closures

`Segment.downstream` is an optional `Record<Key, Key[]>` that maps an upstream key to the list of cels in its transitive downstream set. It's fully derivable from `inputMap` — shipping it is a startup-latency optimization for the consumer, not a correctness requirement.

```ts
interface Segment {
  // ...
  downstream?: Record<Key, Key[]>;
}
```

`dehydrate(state, opts?)` decides what to put there:

- **Default** — whatever's already in the runtime cache from prior cascade activity. If the host has been running for a while, the hot input keys are already cached and ship for free.
- **`opts.bakeDownstream: Key[]`** — explicit warming. The dehydrator BFSes any of those keys not already cached (one BFS per key, $O(|\text{aff}(k)|)$ each) and ships the result.

```ts
const segments = dehydrate(state, {
  bakeDownstream: ["price", "qty", "user.id"],
});
```

`hydrate` reads the field and seeds `indexes.downstream` after precompute, so `set("price", …)` immediately after hydrate skips the BFS warm-up.

The closure is derived data, so a hand-edited segment can drift out of sync with `inputMap`. In dev builds, validate by BFSing each shipped closure and comparing against the live cache. Stale closures are cheap to detect and cheaper to drop than to debug.

## Segment manifests

A segment can ship an optional `manifest` declaring its version, what it provides (lambdas, schemas, tags, channels, cel-segment names it owns), and what it depends on. When present, hydrate validates `dependsOn` against already-loaded manifests and other manifests in the same call (with semver matching) before mutating any state. Successful hydrate records the manifest into `state.segments` after `precompute()` completes; `dehydrate` emits each loaded manifest back onto its segment.

```ts
interface SegmentManifest {
  segment:      string;
  version:      string;                                // semver
  description?: string;
  dependsOn?:   Array<{ segment: string; semver?: string; required?: boolean }>;
  provides?:    {
    lambdas?:     LambdaKey[];
    schemas?:     SchemaKey[];
    tags?:        TagKey[];
    channels?:    ChannelKey[];
    celSegments?: string[];                            // cel.segment values this owns
  };
}
```

`flush(state, key)` refuses to remove a segment that has declared dependents. Pass `{ cascade: true }` to flush them in topological order first, or `{ force: true }` to drop the manifest and let dependents fail at runtime.

Three locked core fns expose the registry: `getSegmentManifest(state, key)`, `listSegments(state)`, `findDependents(state, key)`. The semver subset shipped inline supports `*`, exact, `^`, `~`, and the comparator forms (`>=`, `<=`, `>`, `<`, `=`); compound `||` and x-ranges intentionally return `false` (out of scope).

Reserved segment keys: `"core"` (kernel-internal seeds, always present), `"config"` (per-feature `config_*` cels), `"stats"` (observation cels written by the kernel — filtered from dehydrate), `"default"` (cels with no `segment` field). Package segments use the package name; cels they place in shared segments must use `<package>_` or `<package>:` key prefixes so the shared-cleanup heuristic can identify them at flush.

The whole layer is opt-in. A segment without `manifest` hydrates exactly as before and creates no `state.segments` entry. See `examples/segments-introspect-demo` for a full lifecycle walkthrough.

## State changes through the DAG

A write to cel $k$ scopes the affected set, then walks the level structure:

$$
\text{aff}(k) \;=\; \text{downstream}(k) \,\cup\, \text{dynamicCascade}
$$

```
for wave in sortedWaves:
    for level in waveCascade[wave]:
        for cel in level if cel ∈ aff(k):
            fire(cel)        ← in parallel within the level
        await level barrier
```

Within a level, cels are mutually independent — no transitive dep edge between any two. Sync cels complete inline; async cels run concurrently via `Promise.all` at the level barrier. Across levels (and across waves), the barrier guarantees every level-$N$ write is visible before level-$N+1$ reads.

**Suppression.** A cel only fires when at least one of its inputs is in the `changed` set. The cascade walks the closure to check, but it skips the lambda body when no input materially changed. So:

- *walk cost* $\;=\; O(|\text{aff}(k)|)$
- *fire cost* $\;=\; \sum_{c \in \text{changed}(k)} t_c$

where $t_c$ is the execution time of cel $c$'s lambda. Sustainable write rate:

$$
\Lambda_{\max} \;=\; \frac{1}{\sum_{c \in \text{changed}(k)} t_c}
$$

For a 10 000-cel cascade with $t_c \approx 1\,\mu s$, that's ~100 writes/sec before the event loop falls behind. The conditional-await pattern in `runCascade` means an all-sync graph runs without microtask yields; one async lambda anywhere in the closure adds one microtask per cycle, not one per fn.

## State and lambdas

State holds a flat record of maps:

| Field | Contents |
|---|---|
| `cels: Map<Key, Cel>` | the graph |
| `fns: Map<LambdaKey, Fn>` | callable bodies — pure functions |
| `fnMetadata: Map<LambdaKey, LambdaMetadata>` | static description (kind, schemas, source, locked) |
| `schemas: Map<SchemaKey, ZodType>` | live Zod validators |
| `schemaMetadata` | per-schema isChanged / diff fn keys |
| `tagRegistry` | per-format protocols for opaque values (Buffers, handles, streams, …) |
| `channelRegistry` | side-effect outputs (see _Channels_) |
| `fnDispose` | runtime cleanup hooks for registered fns |
| `precomputeGeneration: number` | topology-version token (see _Non-essential optimization_) |
| `segments: Map<Key, SegmentManifest>` | loaded-segment registry (see _Segment manifests_) |
| `perfScratch`, `perfFunctions`, `perfChannels` | opt-in tracking buckets (see _Performance tracking_) — empty unless `config_performance.v.enabled` is true |

A cel:

```ts
interface Cel {
  key:        string;
  v:          unknown;
  l?:         LambdaKey;            // lambda OR compiler key in state.fns
  f?:         string;                // source — compiler at state.fns.get(l ?? "f") consumes
  inputMap?:  Record<string, Key | Key[]>;
  segment?:   string;
  schema?:    ZodType;
  wave?:      number;                // default 0
  channel?:   ChannelKey | ChannelKey[];
  locked?:    boolean;
  dynamic?:   boolean;               // re-fires every cycle
  tag?:       TagKey;
}
```

**All lambdas live as Fns in `state.fns`** — native JS bodies and source-compiled ones (formula, python, scheme, wasm, …). No parallel kind-handler registry: compilers are themselves Fns keyed by language.

```
state.fns.get("f")       ← default S-expression compiler (parses cel.f → runtime fn)
state.fns.get("scheme")  ← register a Scheme compiler; cels can use cel.l = "scheme"
state.fns.get("py")      ← Python compiler; cel.l = "py"
```

A compiler takes a source string, returns a `CompiledLambda` — either a bare `Fn` or an envelope `{ fn, dispose?, buildEvaluate? }`. `dispose` fires when the cel is overwritten or removed. `buildEvaluate` is the optional fast-path closure builder consumed by precompute (see _Non-essential optimization_).

Runtime install:

```ts
state.fns.get("registerLambda")!(state, {
  key: "myLambda",
  fn: (a, b) => a + b,
  arity: 2,
  inputSchema: "twoNumbers",
});
```

Atomicity: pre-flight (lock check, fn-xor-source, compiler resolution, compilation) runs before any state mutation. A failing `registerLambda` leaves state untouched.

Atomic complete-tier cel ops:

```ts
await setCel(state, "total", { f: "(+ a b)" });        // swap formula
await setCel(state, "total", { f: null, l: null, v: 42 });  // convert to value cel
```

The `CelTriple` shape `{v?, f?, l?}` distinguishes "absent" (leave alone), `null` (clear), and concrete (install). Setting `f` or `l` triggers re-compile + precompute; setting `v` alone is the fast value-write path.

## Waves: arbitrary sequencing in topologies

Most reactive systems use one big topological sort. Plastron adds a layer above: `cel.wave: number`. Wave $N$ runs to completion before wave $N+1$. Within a wave, Kahn levels run in sequence.

This lets you express coarse phases without threading inputMap edges across the boundary:

```
wave 0: data cels (inputs, prices, qty)
wave 1: derived cels (totals, ratios)
wave 2: presentational cels (formatted strings, vnodes)
```

Wave is a coarse phase, not a fine one. In practice you reach for it rarely — the dependency graph alone usually expresses ordering correctly. Use cases where waves earn their keep:

- **Pure-value layering without explicit edges.** Two tiers of data where the dependency relationship is by convention rather than by `inputMap`.
- **Defensive boundaries between segments.** Two segments hydrated together that don't know each other's cels can use distinct waves to enforce that segment-A's outputs are settled before segment-B reads them.

Most apps leave wave at 0, declare dependency edges, and let the topology handle ordering.

## Waves: parallel topologies within each wave

Within a wave, Kahn levels are mutually independent — by construction, no transitive dep edge between any two cels in the same level. The cascade fires them concurrently:

```ts
for (const level of waveCascade.get(wave)!) {
  let promises: Promise<void>[] | null = null;
  for (const key of level) {
    if (!affected.has(key)) continue;
    const r = fireCel(state, key, suppression, changed);
    if (r instanceof Promise) {
      promises ??= [];
      promises.push(r);
    }
  }
  if (promises) await Promise.all(promises);
}
```

For sync graphs (`fireCel` returns void), `promises` stays null and `Promise.all` never runs — no parallelism overhead. For graphs with async cels at the same level, the level barrier becomes a parallelism boundary: $N$ independent fetch-bound cels finish in $\max(t_c)$ rather than $\sum(t_c)$.

The kernel doesn't use Workers — single-threaded JS, parallelism is await-interleaving on the main thread. That's the right tool for I/O-bound async fns, not CPU-bound work. For CPU parallelism, hosts can run computation in workers and expose the result as an async fn the cascade awaits.

## Channels

When a cel changes, the kernel routes the change to whatever side-effect outputs the cel is bound to. A channel is a pluggable output:

```ts
interface ChannelHandler {
  enqueue:    (args: { cel: Cel; state: State }) => void;
  hasPending: () => boolean;
  drain:      () => void | Promise<void>;
  dispose:    () => void;
}
```

Different channels have different commit policies. The kernel just routes; the channel decides whether to coalesce, when to commit, and how:

| Channel | Scheduler | Coalescing |
|---|---|---|
| DOM | rAF | per-root: latest patch wins |
| Audit log | sync | none — every diff appended |
| Persist (IndexedDB) | debounced | merge-by-key |
| Network | microtask-batched | batch into one request |
| Audio | audio-clock | none — per-frame writes |
| Test | sync | swappable for the channel under test |

Cels declare bindings via `cel.channel`. After the cel's value updates, the kernel calls the bound handler's `enqueue`. Handlers track their own queue; their `drain` commits everything pending. Sync drains return `void`; async drains (IndexedDB writes, fetch, file I/O) return `Promise<void>` — `flushChannels` runs them concurrently in fixed-point iterations and only awaits when something async is in flight.

**Channel saturation.** Each channel has an arrival rate $\lambda_C$ (changed cels per second routed to it) and a service rate $\mu_C$ (commits per second the scheduler can sustain). Define utilization

$$\rho_C \;=\; \frac{\lambda_C}{\mu_C}$$

For coalescing channels: $\rho_C > 1$ doesn't grow memory but produces user-visible staleness $\approx \max(0,\; 1 - 1/\rho_C) \cdot \tau_C$ where $\tau_C$ is the tick period. For non-coalescing: queue length follows M/M/1, $L_q = \rho_C^2 / (1 - \rho_C)$ when $\rho_C < 1$, unbounded growth at $\rho_C \geq 1$. The kernel can't bound something it doesn't get to see — backpressure on a non-coalescing sink is a host-design concern.

**Fixed-point drains.** When `set(..., { flush: 'all' })` triggers a drain, channel commits may write back to the graph and kick further cascades. The drain iterates until no channel reports `hasPending`, capped at 64 — runaway feedback surfaces as an error rather than a hung tab.

## Performance tracking

Off by default. Set `config_performance.v.enabled = true` and the kernel writes per-cycle stats to cels under the `"stats"` segment: `stats_precompute` (graph-level memory + topology snapshot), `stats_cycles` (per-cycle timing + fired/skipped counts + per-wave durations), `stats_functions` (per-lambda call count + total ns), `stats_channels` (per-channel enqueues/drains/queueDepth). The disabled hot path is one ternary check per `fireCel` and one `Map.get` per cycle — no allocations.

Two distinct env cels live in the `"config"` segment:

- **`stats_environment`** — kernel-detected runtime capabilities (workers, SAB, atomics, WASM SIMD, WebGPU adapter, hardwareConcurrency, high-res timing). Populated regardless of `enabled` because hosts use it to gate optional optimization registrations. Filtered from dehydrate.
- **`config_environment`** — host-managed project profile: derived segments list, host feature flags (`setFeatureFlag`), free-form tags (`setEnvironmentTag`), an optional frozen runtime snapshot (`freezeRuntimeProfile`). Round-trips through dehydrate so a saved project knows what runtime it was last validated against. Stats snapshots include a `configEnvGen` correlation field.

Locked core fns: `resetStats`, `refreshEnvironmentStats`, `setFeatureFlag`, `setEnvironmentTag`, `syncSegmentsToConfig`, `freezeRuntimeProfile`, `compareRuntimeProfile`. The `config_performance.v` cel is bound to a Zod `passthrough()` schema so misconfiguration throws at hydrate while leaving room for host-defined extension flags.

Memory accounting uses a depth-capped `estimateBytes` heuristic — exact for typed arrays / `ArrayBuffer`, table for primitives, recursive for plain objects — with optional per-schema (`SchemaMetadata.byteLength`) and per-tag (`TagHandler.byteLength`) overrides for opaque values. See `examples/perf-tracking-demo` for the full surface.

## Language interop and WASM

Plastron treats every language as a compiler — a Fn that takes source, returns a runtime body. The default is the S-expression formula compiler at `state.fns.get("f")`. To swap in another, register at a different key:

```ts
await registerLambda(state, {
  key: "scheme",
  fn: (src: string) => ({
    fn: (inputs: Record<string, unknown>) => wasmRepl.eval(src, inputs),
    dispose: () => { /* tear down VM resources */ },
  }),
});
```

A cel using Scheme: `cel.l = "scheme"`, `cel.f = "(+ a b)"`. At hydrate time (or `setCel({ f: "..." })` time), the compiler runs against the source, populates `cel._fn`. The cascade calls it like any other lambda.

WASM compilers are common. `plastron-eshkol` is the canonical example: a Scheme/Lisp implementation compiled to WebAssembly via Emscripten, exposing `repl_eval(source) → string`. The kind handler wraps it as a Fn; each cel's source is evaluated by the shared VM instance.

### CSP

Browsers with strict Content Security Policy block dynamic code. Two relevant directives govern what plastron can use:

| CSP `script-src` | `new Function()` | `WebAssembly.compile()` |
|---|---|---|
| (no policy) | works | works |
| `'unsafe-eval'` | works | works |
| `'self' 'wasm-unsafe-eval'` | blocked | works |
| `'self'` only | blocked | blocked (browser-dependent) |

The default formula compiler auto-detects at module load by trying `new Function("return 1")()`. If it works, `compileFormula` emits `new Function`-codegen for tighter inlining. If it throws, the AST-walk fallback handles the same formulas with a slower but functionally identical evaluator.

WASM compilers can run under `'wasm-unsafe-eval'` even when JS eval is blocked — a real configuration in CSP-locked production apps. Boundary cost (Web↔WASM marshalling) makes WASM the wrong tool for trivial sheet formulas (`(+ a b)` evaluates faster as JS than WASM), but the right tool for languages that need a real runtime: Scheme, Python, SQLite. The Eshkol terminal example runs entirely under `'wasm-unsafe-eval'`.

## Non-essential optimization

The kernel splits precompute into two phases. The cascade fires correctly after the essential phase; everything in the optional phase is pure speedup with a fallback path in `runCascade`.

**Essential** (sync, must complete before any cascade fires):

- `waveCascade`, `sortedWaves`
- `children` (reverse adjacency, $O(E)$)
- Empty `downstream` cache (fills lazily as writes arrive)
- `dynamicCascade`
- Invalidate per-cel runtime caches
- Bump `state.precomputeGeneration`
- Write the indexes back to the `precomputedStates` cel

**Optional** (async, chunked, cancellable, runs in the background):

- For each cel, in chunks of 256 with a microtask yield between:
  - `cel._inputEntries` — `inputMap` resolved to live cel refs (skip Map.get per fire)
  - `cel._channelHandlers` — `cel.channel` resolved to live handlers (skip Array.isArray + Map.get per fire)
  - `cel._evaluate` — compiler-supplied closure that captures cel refs directly (skip the inputs-object allocation entirely; for `(+ a b)` this is roughly $10\times$ faster than the standard gather-and-call path)

The cascade is fallback-aware. When a cell fires before the optional pass has populated its caches, `fireCel` walks `cel.inputMap` and resolves refs live; `enqueueChannels` looks up channels from `state.channelRegistry` per fire. Same answer, slower.

**Cancellation via generation token.** Every essential pass bumps `state.precomputeGeneration`. The optional pass captures the value at start and re-checks before every commit. A topology mutation mid-flight (another `setCel`, a `flush`, a re-hydrate) bumps the token and the in-flight pass aborts cleanly at the next checkpoint — no half-resolved closures land on cels the new graph reshaped. A new optional pass schedules automatically.

**Async compilers.** A compiler that needs async setup (compile a WASM module, instantiate a worker, fetch a remote artifact) returns `Promise<() => unknown>` from `buildEvaluate`. The optional pass awaits the Promise inside its chunked loop. The cascade keeps using the slow path until the WASM module is ready; once `cel._evaluate` is set, subsequent cascades use the fast WASM call. **The client doesn't wait for compilation to complete before showing the first cascade result** — it sees partial results from the slow path immediately and accelerates as the optional pass finishes.

This is the core architectural trade. Everything that *could* block the first paint — JSON Schema → Zod (well, that one's still essential because cascade cares), input resolution, channel handler resolution, formula codegen, WASM module instantiation — gets either pulled into the essential phase if the cascade truly needs it, or pushed to the optional phase with a fallback path in `runCascade`. Every async setup happens off the critical path.

## What's in segments/

Each is its own package; treat them as examples of how to extend the kernel rather than a stable ecosystem yet.

- `plastron-dom` — vnode schema + DOM channel that mounts a cel tree to the document.
- `plastron-archive` — read/write `.甲` archive files (zip-of-JSON segments).
- `plastron-chart` — small bar-chart vnode helper.
- `plastron-pdf` — position-aware PDF text extraction via pdfjs-dist.
- `plastron-xlsx` — minimal SpreadsheetML reader.
- `plastron-eshkol` — Scheme/Lisp lambda kind via WASM.

## Examples

- `examples/plastromancy` — the namesake showcase, a Shang divination ritual that exercises every kernel feature. See [`plastromancy.md`](plastromancy.md).
- `examples/plastron-sheet` — Excel-style spreadsheet UI on top of plastron.
- `examples/plastron-spa-demo` — Vite SPA with nav and lazy segment loading.
- `examples/eshkol-terminal` — REPL for the Eshkol kind.
- `examples/segments-introspect-demo` — manifest-driven hydrate / cascade-flush / round-trip walkthrough.
- `examples/perf-tracking-demo` — opt-in stats cels + env config + 28-check smoke test.

Each example has its own README and is run with `npm install && npm run dev` (or `npx tsx src/index.ts` for the node-only ones).

## Status

v0.0.0. The kernel is small and the API surface is still moving. Expect breakage. The current focus is reconciling the segment ecosystem and example apps with the simplified kernel.

## License

[MIT](LICENSE).
