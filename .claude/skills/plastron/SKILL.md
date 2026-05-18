---
name: plastron
description: Build reactive computation graphs with the plastron library. Use this skill when the user asks to model reactive state, dependency graphs, spreadsheet-like recalculation, or specifically mentions plastron, cels, segments, channels, or building a plastron app/segment. Pairs with DESIGN.md (how to scope plastron projects) and COOKBOOK.md (concrete patterns).
---

# plastron — reactive DAG engine

A cel is a keyed value in a graph. Writing a cel fires a cascade that recomputes every downstream cel. That's the whole model. Side effects to the outside world flow through **channels**.

> **Before you write any cels:** read **DESIGN.md** "First design rule" — cels mark reactivity boundaries. Inner compute belongs in native fns, not in cascades of intermediate formula cels. The bench numbers (`bench/RESULTS.md`) show 26× swings between the same workload done two ways. This is the single biggest design lever in plastron.

This file is the API reference. For project shape (app vs segment, lifecycle, cel granularity, anti-patterns) see **DESIGN.md**. For concrete patterns (one-cel pattern, dehydration, diffing, persistence, hosting) see **COOKBOOK.md**.

Everything described lives in `plastron/src/`. Segments live in `segments/`. Examples live in `examples/`.

---

## Core model

- **Cel** — one keyed value. Stored at `state.cels.get(key)`. Has `key`, `v`, plus optional role fields (`l`, `f`, `inputMap`, `segment`, `schema`, `channel`, `ref`, `wave`, `dynamic`, `locked`, `tag`).
- **State** — `{ cels, fns, fnMetadata, schemas, schemaMetadata, tagRegistry, slotAccessors, channelRegistry, segments, … }`. Returned by `createInitialState()`.
- **Segment** — `{ key, cels: DehydratedCel[], fnMetaData?, schemas?, schemaMetadata?, manifest? }`. The unit of hydration and flushing.
- **Channel** — pluggable side-effect output. Bound to cels via `cel.channel`. When a bound cel changes, the kernel calls `handler.enqueue({cel, state})`. Channels own coalescing and commit timing (rAF, microtask, debounce, …). See `plastron/src/types/channels.ts`.
- **Cascade** — one walk of the affected closure. Triggered by every write. Built from `_inputEntries` at precompute, fired in wave order.

---

## Calling convention

Everything goes through `state.fns`. There is no facade — no `runtime()`, no `plastron()`, no `state.input`. Look up the fn by name and call it with `state` as the first arg.

```ts
import { createInitialState, type Fn } from "plastron";
import { precomputeOptional } from "plastron";       // fast-path closure builder

const state = createInitialState();
const hydrate  = state.fns.get("hydrate")  as Fn;
const set      = state.fns.get("set")      as Fn;
const batch    = state.fns.get("batch")    as Fn;
const get      = state.fns.get("get")      as Fn;
const runCycle = state.fns.get("runCycle") as Fn;

await hydrate(state, [mySegment], [myFns]);
await runCycle(state);                              // prime
await precomputeOptional(state);                    // gate the codegen fast path

await set(state, "qty", 4);                         // one write, one cascade
await batch(state, [["qty", 4], ["price", 12]]);    // many writes, ONE cascade

console.log(get(state, "total"));                   // sync read
```

**Use `batch` whenever there are multiple writes per tick.** Sequential `set` calls run a full cascade per call — N writes = N cascades. `batch` dedups firedKeys and runs one cascade for the union. The Game of Life bench measured a **14× speedup** from this change alone (see `bench/RESULTS.md`).

**Call `precomputeOptional(state)` after `runCycle`** to enable per-cel codegen closures (`_evaluate`). Without it every fire goes through the AST-walk slow path — ~10× slower on cascade-shape workloads.

### Core fns (registered by `createInitialState`)

| Key | Signature | Purpose |
|---|---|---|
| `hydrate` | `(state, segments, fns?) → Promise<State>` | Merge cels into state. Validates manifests, auto-wires inputMap, runs precompute, primes new lambda cels. |
| `dehydrate` | `(state, opts?) → Segment[]` | Serializable inverse of hydrate. Drops runtime-only fields. Filtered to user segments by default. |
| `runCycle` | `(state) → Promise<State>` | Fire the dynamic cascade (cels marked `dynamic: true`). Call once at boot to prime. |
| `set` | `(state, key, value, opts?) → Promise<State>` | Single write; one cascade. `opts.flush` drains channels after. |
| `batch` | `(state, [[k,v], …], opts?) → Promise<State>` | Multiple writes merged into one cascade. |
| `get` | `(state, key) → unknown` | Sync read of cel value (resolves through refs). |
| `touch` | `(state, key) → Promise<State>` | Force cel + downstream to refire. |
| `consume` | `(state, opts?) → Promise<State>` | Drain pending buffered writes (manual mode). |
| `flush` | `(state, segmentKey) → State` | Delete every cel whose `segment === key`, fire `_dispose` hooks, drop from `state.segments`. |
| `drain` | `(state, spec?) → Promise<void>` | Flush channels to fixed point. `spec` = `"all"` or a `ChannelKey`. |
| `setCel` / `setCelBatch` | … | Complete-tier writes that change `{v,f,l,ref}` together. Used for live formula edits. |
| `registerLambda` | … | Runtime lambda registration. |
| `listSegments` / `getSegmentManifest` / `findDependents` / `satisfies` | … | Manifest introspection (also re-exported from `plastron`). |

---

## Cel roles

A cel's role is the combination of optional fields that are set.

### Value cel (writeable)
```ts
{ key: "qty", v: 3, segment: "cart" }
```
Write via `set` / `batch`.

### Constant (locked)
```ts
{ key: "rate", v: 0.08, segment: "config", locked: true }
```
Hydrate refuses to overwrite. `set` errors.

### Lambda cel (computed via named fn)
```ts
{
  key: "total",
  segment: "cart",
  l: "multiply",
  inputMap: { a: "price", b: "qty" },
}
```
The lambda runs with `{a, b}` resolved from upstream cels. Return becomes `cel.v`. `inputMap` values can be `Key` or `Key[]` (array form passes an array of values).

### Formula cel (compiled source)
```ts
{ key: "total", segment: "cart", f: "(* price qty)" }
```
Bare symbols that aren't builtins (`price`, `qty`) become cel-key dependencies. Hydrate's auto-wire pulls them into `inputMap` for you. `cel.l` defaults to `"f"` (the formula compiler in `state.fns`) but can name a different compiler (e.g. `"augur"`).

**Formula syntax is S-expression (Lisp-style).** See `plastron/src/core/formula.ts`.

```
(+ a b)              variadic arithmetic
(- a b)              variadic subtraction (with unary negate)
(* a b c)            variadic product
(/ a b)              variadic division
(myFn a b)           function call — myFn must resolve via inputMap
                     to a function value (i.e. a native-fn cel)
(+ (* a b) c)        nested
"hello"              string literal — double-quoted, supports \" \\ \n \t \r
42                   numeric literal
null  true  false    reserved literals
```

**There are only four builtins: `+ - * /`.** Everything else — comparisons, `if`, `min`/`max`, `pow`, string ops — is a **native-fn cel**: put a JS function as the cel's `v` and reference its key as the list head:

```ts
{ key: "nextOf", segment: "life", v: (sum, current) => /* … */ },
{ key: "cell_5_3", segment: "life", f: "(nextOf (+ p44 p45 p46 p54 p56 p64 p65 p66) p55)" }
```

Cel keys used as formula symbols must be valid bare atoms (no spaces, parens, or quotes). For keys that can't be bare atoms, use `inputMap` + `l:` (the lambda-cel form) instead.

### Ref cel (slot alias)
```ts
{ key: "row42_name", ref: { source: "people", slot: "name@42" }, segment: "view" }
```
Holds no `v` of its own; reads resolve through the source's `SlotAccessor`. Mutually exclusive with `f`/`l`. See `plastron/src/core/refs.ts`.

#### SlotAccessor.write contract

`SlotAccessor.write(src, slot, value)` returns the new source value, and the kernel branches on **reference identity** with the old source:

- **Returned `=== src` (in-place + gen-bump path).** The kernel skips reinstalling the source value and fires the cascade from the source key directly. The accessor MUST mutate `src` in place AND bump a generation counter the source's `isChanged` lambda keys on — otherwise the kernel's reference-equality short-circuit suppresses the cascade. This is the typed-array path used for `plastron-collections` `Column` / `Matrix` (`segments/plastron-collections/src/refs.ts:82-96`).
- **Returned a new object (wholesale-replace path).** The kernel re-enters `writeOne` on the source key with the returned value, replacing the cel's `v` entirely. Use this when in-place mutation isn't an option (immutable inputs, structural rewrites like Table's `{...src, columns: {...}}`).

**Trap:** an accessor that shallow-clones (`return {...src}`) AND bumps `gen` on the clone defeats both paths — the kernel sees a new reference (replace path), reinstalls it, and the gen bump is wasted. Pick one path and commit to it.

### Wave / dynamic / channel attributes
- `wave: 1` — cel runs after every `wave: 0` cel in the same cascade finishes. Useful for aggregators.
- `dynamic: true` — cel fires in every cascade regardless of input changes. Clocks, counters.
- `channel: "x"` or `["x", "y"]` — value-change routes to one or more channel handlers.

---

## Channels — the "change pipes"

A channel is a `ChannelHandler` registered in `state.channelRegistry` and bound to cels via `cel.channel`. When a cel's value changes inside `runCascade`, the kernel calls `handler.enqueue({cel, state})`. The handler decides what to commit, when, and whether to coalesce.

```ts
interface ChannelHandler {
  enqueue:    (args: { cel: Cel; state: State }) => void;
  hasPending: () => boolean;
  drain:      () => void | Promise<void>;
  dispose:    () => void;
}
```

The handler reads `cel.v` (new value) and `cel._diff` (last diff, if a `_diffFn` is attached). The kernel does not pre-decide which one matters.

### Diffing

Set `cel.schema` to a `z.ZodType`. Register a matching `SchemaMetadata` with `isChanged` and `diff` lambda keys. Hydrate auto-wires `cel._isChanged` and `cel._diffFn`. After each cascade, the kernel:

1. Calls `_isChanged(prev, next)` to decide if the cel really changed (cheap structural-equality check).
2. If changed, calls `_diffFn(prev, next)` and stores the result on `cel._diff`.
3. Routes to channels — the handler can now read `cel._diff` for a minimal patch.

This is how `plastron-dom` produces vnode patches and applies them via rAF: see `segments/plastron-dom/src/index.ts:138-247`.

### Draining channels

Channels run on their own clocks by default (rAF, microtask, debounce). Three ways to force a sync drain:

```ts
await set(state, "key", v, { flush: "all" });       // after this write
await set(state, "key", v, { flush: "myChannel" }); // just one
await drain(state, "all");                          // standalone
```

`drain` loops to fixed point — a channel commit may write back via `set`, kicking another cascade. Capped iterations guard against feedback loops.

### Registering a channel

Done by the segment that owns it, inside its `installX` function:

```ts
state.channelRegistry.set("myChannel", {
  enqueue: ({cel}) => queue.push(cel.key),
  hasPending: () => queue.length > 0,
  drain: () => { /* commit */ queue.length = 0; },
  dispose: () => { /* cancel timers, detach listeners */ },
});
```

Cels referencing a channel that isn't yet registered are silently dropped from channel routing — **register channels before hydrating cels that bind to them.**

---

## Segments

Group cels by their `segment` field. Segments are the unit of:

- **Flushing**: `flush(state, "cart")` deletes every cel whose segment is `"cart"`, fires their `_dispose` hooks, removes the manifest entry from `state.segments`.
- **Hydrating**: `hydrate(state, segments, fns?)` is incremental — adds to whatever's already there.
- **Manifests**: declare dependencies, version, what the segment registers. Optional but recommended.

```ts
const manifest: SegmentManifest = {
  segment: "my-segment",
  version: "1.0.0",
  description: "What this segment does.",
  dependsOn: [{ segment: "plastron-dom", semver: "*" }],
  provides: {
    lambdas:     ["myCompute"],
    schemas:     ["mySchema"],
    channels:    ["myChannel"],
    celSegments: ["my-segment"],
  },
};
```

Reserved segment keys: `"core"` (kernel seeds, never flushed), `"config"` (tunables — every plastron-* segment owns `config_<name>` cels here), `"stats"` (telemetry, filtered out on dehydrate), `"default"` (fallback for cels with no segment).

---

## Archives — dehydrate and hydrate to bytes

`segments/plastron-archive` round-trips State → `Uint8Array` and back, via the xit content-addressed store.

```ts
import { exportArchive, importArchive } from "plastron-archive";

const segments = dehydrate(state);                  // Segment[]
const bytes = await exportArchive(segments, opts);  // Uint8Array

// later, in a fresh state:
const { segments, manifest, archive } = await importArchive(bytes);
await hydrate(state, segments, []);
```

This is the on-disk plastron format. The user-facing name for it is **甲 file** (`.甲`).

Archive bytes don't include channel registries or fn implementations — only data. The host re-runs `installX(state, …)` on the receiving side to install the same channels/lambdas before hydrating.

---

## Writing custom lambdas

Three pieces: a function, metadata, and a registry. The cleanest place to declare them is on the segment, so hydrate registers them for you.

```ts
import type { Segment, LambdaMetadata, Fn } from "plastron";

const sumLineItems = ({ prices, quantities }: { prices: number[]; quantities: number[] }) => {
  let t = 0;
  for (let i = 0; i < prices.length; i++) t += prices[i] * (quantities[i] ?? 0);
  return t;
};

const meta: LambdaMetadata = {
  key:          "sumLineItems",
  description:  "Element-wise dot product.",
  inputSchema:  "object",
  outputSchema: "number",
  arity:        2,
  source:       sumLineItems.toString(),
};

const segment: Segment = {
  key: "cart",
  cels: [{ key: "total", segment: "cart", l: "sumLineItems", inputMap: { prices: "ps", quantities: "qs" } }],
  fnMetaData: { sumLineItems: meta },
};

await hydrate(state, [segment], [new Map([["sumLineItems", sumLineItems]])]);
```

There is no large "default operator bundle" — the formula compiler only knows `+ - * /`. Anything else is either:
- a **native-fn cel** (function as cel `v`, referenced by key in formulas), or
- a **lambda cel** with `l: "myFnKey"` + an entry in `fnMetaData` + the fn in the fnRegistry (as shown above).

Use native-fn cels when the function is conceptually data (live-editable, dehydratable as `toString()`). Use lambda cels when the function is a registered behavior shared across many cels.

---

## Idioms

### Put display formatting in the graph
Don't assemble strings in TS — write a lambda that takes the pieces and returns the rendered string. Caller reads one cel.

### Event streams → batch
Rapid producers (drag handlers, sensor feeds) push into a JS queue; a flusher drains via `batch` on a debounce. See COOKBOOK.md.

### Per-session state in its own segment
When the session ends, `flush(state, sessionKey)` clears it. Catalog / reference data lives in a separate segment that survives.

### State methods from inside a lambda
Sync side effects (`flush`, `set`, `touch`) are safe to call from lambdas (they're exposed as cel values under the reserved `"state"` segment). Async cycle-firing fns (`hydrate`, `consume`) re-enter the engine — prefer calling those from the orchestrator.

### `_prev` for last-output memory
`prevDepth: N` on a lambda cel injects `_prev: unknown[]` into its inputs — `_prev[0]` is the most recent past output. Useful for "last route" / "last tick" comparisons.

---

## Strict-type validation (optional)

`config_recalculation.v.strictTypes = true` validates every lambda's inputs + outputs against the schema keys in its `LambdaMetadata`. Failures land in the reserved `errors` cel; the cycle continues.

---

## Pitfalls

### Performance cliffs

- **N sequential `set` calls = N cascades.** Use `batch` for multiple writes per tick. Measured: Life at 20×20 went 6.20 ms → 0.44 ms (14×) just by switching. This is the single biggest plastron performance trap.
- **Without `precomputeOptional(state)`, formulas walk the AST on every fire.** Call it once after `runCycle` to enable per-cel codegen closures. ~10× difference on cascade-shape benches.
- **Channels are not write batching.** `cel.channel` + `state.channelRegistry` coalesce *output* side effects (DOM patches, IDB transactions). For *input* coalescing on the way in, use `batch`. Easy confusion from the naming.

### API foot-guns

- **State field is `cels`, lowercase.** `state.cels.get(key)`. Not `state.Cels`.
- **No facade.** Don't reach for `runtime()` / `plastron()` / `state.input` — they don't exist. Use `state.fns.get(name)` directly.
- **`set` is async** and awaits the full downstream cascade. A write that affects 10k cels won't resolve until all 10k recompute.
- **`set` on an unchanged value is a no-op** unless the cel sets `_isChanged: () => true` or uses a schema whose `isChanged` returns true.
- **Cel keys used as formula symbols** must be valid bare atoms (no spaces, parens, quotes, or reserved words `null`/`true`/`false`). Use `inputMap` + `l:` for everything else.
- **Register channels before hydrating cels that bind to them.** Late-registered handlers are silently dropped from cel routing.
- **`channel` references must match a registered handler.** Mistyped channel keys silently no-op.
- **Cel keys must be non-empty strings without whitespace.** Validated in hydrate.
- **Lambda cels downstream of only `locked` cels won't fire on their own.** A locked cel can't be written, so nothing triggers its downstream. Use `dynamic: true`, `touch` an upstream, or rely on hydrate's auto-priming (which fires every null-valued lambda once).

### Known sharp edges

- **Linear chain depth ≈ 5000.** `buildDownstream` in `plastron/src/core/precompute.ts` recurses; chains past ~10k overflow V8's stack. Real bug, not a doc issue. Cap deep-chain workloads accordingly.
- **Per-cel memory cost is real.** Bench measured: value cel ~330 B, formula cel ~1640 B post-evaluate. At 1M cels that's 330 MB / 1.6 GB. Plan accordingly.
- **GC variance.** Per-iteration timing CV jumps to 50–100% at small N because GC fires unpredictably. Use `--expose-gc` and the bench harness's `gcBetween` for memory-sensitive measurements.

---

## Pointers

- `plastron/src/types/` — Cel, DehydratedCel, Segment, State, ChannelHandler, SegmentManifest
- `plastron/src/core/hydrate.ts` — hydrate (the primary async entry point)
- `plastron/src/core/runCycle.ts` — runCycle (fires dynamic cascade)
- `plastron/src/core/input.ts` — get / set / batch / touch / consume / setCel / drain
- `plastron/src/core/flush.ts` — flush (segment teardown)
- `plastron/src/core/precompute.ts` — precompute + precomputeOptional (codegen fast path)
- `plastron/src/core/formula.ts` — S-expression compiler with `+ - * /` builtins
- `plastron/src/core/refs.ts` — ref cels and slot accessors
- `plastron/src/core/perf.ts` — opt-in performance tracking, stats cels
- `segments/plastron-dom/src/index.ts` — reference shape for a channel-owning segment
- `segments/plastron-archive/src/` — `.甲` round-trip
- `examples/plastron-spa-demo/` — reference shape for a plastron-first app
- `bench/RESULTS.md` — benchmark numbers and "what this is / isn't" framing

For "how do I scope this project?" → **DESIGN.md**.
For "how do I do X?" → **COOKBOOK.md**.
