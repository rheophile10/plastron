---
name: plastron
description: Build reactive computation graphs with the plastron library. Use this skill when the user asks to model reactive state, dependency graphs, spreadsheet-like recalculation, or specifically mentions plastron, the 龜卜藏 API, cels, segments, or the runtime() / plastron() helpers.
---

# Plastron — reactive DAG engine

A cel is a keyed value in a graph. Writing a cel triggers a cycle that recomputes every downstream cel. That's the whole model.

Everything described here lives in `plastron/src/`. Examples live in `examples/`.

---

## Quick start

```ts
import { runtime } from "plastron";

const rt = await runtime([{
  price: { segment: "demo", v: 100 },
  qty:   { segment: "demo", v: 3 },
  total: { segment: "demo", f: "*(@price, @qty)" },
}]);

console.log(rt.input!.get("total"));   // 300 (primed on hydrate)
await rt.input!.set("qty", 4);
console.log(rt.input!.get("total"));   // 400
```

Or the plastronomy-themed face (same library, Chinese method names):

```ts
import plastron from "plastron";
const 甲 = await plastron([cels]);
console.log(甲.貞!.察("total"));
await 甲.貞!.刻("qty", 4);
```

Both are async. Both prime the graph automatically.

---

## Core model

- **Cel**: one keyed value. Stored at `state.Cels.get(key)`. Has `key`, `segment`, `v`, plus optional role fields.
- **State** (the object returned by `runtime()`): `{ Cels, flush, hydrate, cycle?, input? }`.
- **Input** (`state.input`): the interactive surface — `{ get, set, batch, touch, consume, buffer }`. Attached by `createRuntime` / `runtime()`.
- **Segment**: a string tag on each cel. `state.flush(segmentKey)` removes every cel with that tag. Four reserved segments hold runtime bookkeeping:
  - `"config"` — user-tunable defaults (recalcMode, schemas, opAliases, changeIndexConfig) + runtime-populated cels (changeIndices, errors).
  - `"indexes"` — derived graph data (tagIndex, downstreamTopology, dynamicCascade, dynamicKeys, flushIndex).
  - `"state"` — state-level methods exposed as cels: `state_hydrate`, `state_flush`. Lambdas can inputMap to these and invoke them.
  - `"input"` — input-level methods: `input_get`, `input_set`, `input_batch`, `input_touch`, `input_consume`. Same pattern.
- **Cycle**: one walk of a cascade. Triggered by every write; assembled automatically.

---

## API surface

### State methods (always available)
| Method | Purpose |
|---|---|
| `state.Cels` | The raw `Map<Key, Cel>`. Power-user access. |
| `state.flush(segmentKey)` | Delete every cel whose `segment` matches. |
| `state.hydrate(cels, lambdas?, fnRegistry?, options?)` | Incremental hydrate: merge more cels into the same state. Async. Returns the same State. |

### Input methods (attached by runtime/createRuntime — use with `!`)
| English | Chinese | Purpose |
|---|---|---|
| `input.get(key)` | `貞.察(key)` | Read cel's value. |
| `input.set(key, value)` | `貞.刻(key, value)` | Single write; one cycle. |
| `input.batch(writes)` | `貞.連刻(writes)` | Array of `[key, value]`; merged into one cycle. |
| `input.touch(key)` | `貞.重(key)` | Force cel + downstream to re-fire. |
| `input.consume()` | `貞.施()` | Manual mode: drain buffer and run. |
| `input.buffer` | `貞.待` | Manual mode: pending cascade. |

### Plastronomy facade (on `龜卜藏` returned by `plastron()`)
| State member | Chinese | |
|---|---|---|
| `Cels` | `骨` | the bones |
| `flush` | `焚` | burn |
| `hydrate` | `增` | augment |
| `cycle` | `卜` | crack |
| `input` | `貞` | charge |

### Entry points
| | When |
|---|---|
| `runtime(cels, lambdas?, fnRegistry?)` from `"plastron"` | Plain-English State. |
| `plastron(cels, lambdas?, fnRegistry?)` from `"plastron"` | 龜卜藏 (Chinese face). |
| `state.hydrate(...)` | Incremental — add segments to existing state. |
| `hydrate()` / `createRuntime()` from `"plastron/state"` | Low-level, rarely needed. |
| `wrap(state)` from `"plastron"` | Plain State → 龜卜藏. |

---

## Cel roles

Every cel is a `Record` entry under its key. The role is expressed by which optional fields are set.

### Variable (writeable)
```ts
{ segment: "demo", v: 3 }
```
Write with `input.set(key, value)` or `input.batch([...])`.

### Constant (read-only)
```ts
{ segment: "demo", v: 10, readOnly: true }
```
Throws if you try to write.

### Lambda cel (computed via named fn)
```ts
{
  segment: "demo",
  l: "add",
  inputMap: { a: "price", b: "qty" },
}
```
The lambda runs with `{a: price.v, b: qty.v}`. Return becomes cel's `v`. `inputMap` values can be `Key` or `Key[]` (array form passes an array of values).

### Formula cel (computed via `cel.f`)
```ts
{ segment: "demo", f: "*(@price, @qty)" }
```
`@key` references become dependencies automatically; hydrate auto-wires `inputMap` and `children`.

Formula syntax (Polish notation, pipe-based):
```
add(@a, @b)                        // binary call
if(@cond, @then, @else)            // ternary
🔄(@x)                              // unary via alias
[+](@a, @b, @c)                    // reduce
[100 +](@x, @y)                    // reduce with accumulator
[1, 2, 3]                          // array literal
@arr |> +(1)                       // pipe map
@arr |?> >(2)                      // pipe filter
@arr |!> >(2)                      // pipe find
'literal' |> concat(@name)         // piped string build
K("key")                           // same as @key
```

**Cel keys referenced in formulas must be ASCII word-characters (`[\w\-.]+`).** Non-ASCII cel keys work in `inputMap` but not in `@key`.

---

## Writing custom lambdas

Three pieces: function, metadata, fnRegistry.

```ts
import type { LambdaMetadata, FnRegistry } from "plastron/state";

const sumLineItems = ({ prices, quantities }: { prices: number[]; quantities: number[] }): number => {
  let t = 0;
  for (let i = 0; i < prices.length; i++) t += prices[i] * (quantities[i] ?? 0);
  return t;
};

const sumLineItemsMeta: LambdaMetadata = {
  key:          "sumLineItems",
  description:  "Element-wise dot product.",
  inputSchema:  "object",
  outputSchema: "number",
  arity:        2,
  source:       sumLineItems.toString(),
};

const rt = await runtime(
  [cels],
  [{ sumLineItems: sumLineItemsMeta }],
  { sumLineItems },
);
```

`fnRegistry` is `Record<LambdaKey, Fn>`. Metadata is `Record<LambdaKey, LambdaMetadata>[]`.

The default operator bundle (`add`, `multiply`, `concat`, `if`, `eq`, `mathRound`, …) is always available without registration. See `plastron/src/lambdas/functions/` for the full list.

---

## Segments

Group cels by their `segment` field. Segments are the unit of flushing:

```ts
state.flush("cart");   // deletes every cel whose segment === "cart"
```

Lambdas are not flushed directly — they live on `cel._fn`, so they vanish with their cels.

Incremental hydration:
```ts
await state.hydrate(
  [newSegmentCels],
  [moreLambdaMeta],
  moreFnRegistry,
);
```
Runs precompute, rebuilds indexes, primes new null lambda cels.

---

## Idioms

### Put display formatting in the graph
Don't assemble display strings in TypeScript — write a lambda that takes the pieces and returns the full rendered string. Orchestrator: `rt.input!.get("report")`.

```ts
// lambda
const report = ({a, b, c}) => `a=${a}\nb=${b}\nc=${c}`;
// cel
{ segment, l: "report", inputMap: { a: "a", b: "b", c: "c" } }
// orchestrator
console.log(rt.input!.get("report"));
```

### Event streams → batch
Rapid event producers (sensor feeds, drag handlers, websocket messages) push into a JS queue; a flusher drains to `input.batch()` on a debounce.

```ts
const queue: Array<[string, unknown]> = [];
setInterval(() => {
  if (queue.length) rt.input!.batch(queue.splice(0));
}, 16);
```

### Per-user / per-session state
Put mutable session cels in their own segment. When the session ends, `state.flush(segmentKey)`. A separate catalog / reference segment survives.

### Dynamic cels
`dynamic: true` on a cel forces it into every cascade regardless of input changes. Rare — used for volatile data (timestamps, request counters).

### Wave-deferred aggregators
`wave: 1` (or higher) on a cel makes it run after all wave-0 cels finish. Typical pattern: "flush after render" cel reads `changeIndices` and logs/persists a cycle summary.

### State methods from inside a lambda
Because the default `"state"` segment exposes `state.flush` and `state.hydrate` as cel values, a lambda can reference them:
```ts
{
  segment: "navigation",
  l: "navigate",
  inputMap: {
    route: "currentRoute",
    flush: "state_flush",           // ← state.flush as an input
  },
  prevDepth: 1,                     // see previous output
}
```
Sync side effects (flush, set, touch) are safe to call from lambdas. Async ones that themselves fire cycles (`hydrate`, `consume`) re-enter the engine and can recurse; prefer calling them from the orchestrator.

### Using `_prev` for last-output memory
Setting `prevDepth: N` on a lambda cel injects `_prev: unknown[]` into its input object. `_prev[0]` is the most recent past *output* (return value), `_prev[1]` the one before, up to N entries. Useful for "last route" / "last tick" patterns where a lambda needs to compare against its previous result.

---

## Strict-type validation (optional)

Set `config_recalculation.v.strictTypes = true` to validate every lambda's inputs + outputs against the schema keys in its `LambdaMetadata`. Failures land in the reserved `errors` cel; the cycle continues.

Default schema bag ships with primitives (`number`, `string`, `boolean`, `array`, `object`), shape schemas (`unopInput`, `binopInput`, `ternopInput`), and a few others. Add your own by mutating `config_schemas.v` before the first cycle.

---

## Errors

The reserved `errors` cel holds `Record<CelKey, ErrorInfo>` for every cel currently in error. `rt.input!.get("errors")` returns the map. An error in one cel doesn't abort the cycle.

---

## File layout (for reference)

```
src/
  common.ts                     Key, Common, varName
  index.ts                      plastron (default), runtime (named)
  lambdas/
    types/lambda.ts             LambdaKey, Fn, LambdaMetadata
    functions/                  default operators (add, concat, if, …)
    metadata.ts                 opsFns + opsMetadata tables
    formula/
      formula.ts                parser + fFn
      aliases.ts                operator symbol → lambda key map
  schemas/
    types/schema.ts             Schema, SchemaKey, SchemaRecords
    schemas.ts                  defaultSchemas
  state/
    types/                      State, Cel, IsChanged, Cascade, WavedCascade
    segments/
      config.ts                 "config" segment cel definitions
      indexes.ts                "indexes" segment cel definitions
    hydration/
      hydrate.ts                hydrate() — the primary async entry
      flush.ts                  flush() + rebuildFlushIndex()
      precompute.ts             topology / wave / downstream / dynamic
    cycle/
      runCycle.ts               the cycle runner builder
      input.ts                  makeInput (get, set, batch, touch, consume)
      cascade.ts                mergeCascades, mergeDynamicCascade
  plastronomy/                  Chinese façade: 龜卜藏, wrap(), 龜刻卜()
```

---

## Pitfalls

- **Cel keys must be ASCII** for formula `@key` references. Chinese/unicode keys work for `inputMap` values but not in `f` strings.
- **`input` is optional on `State`** — always write `rt.input!.get(...)` or guard with `if (rt.input)`. Same for `cycle`.
- **Lambda cels downstream of only read-only cels don't fire on their own.** A read-only cel can't be written, so nothing triggers its downstream. If you need such a lambda to fire during boot, set `dynamic: true`, `touch` an upstream, or rely on hydrate's auto-priming (fires every null-valued lambda once).
- **`input.set` on an unchanged value is a no-op** via `isChanged`. Override per-cel with `cel.isChanged = () => true` for volatile data.
- **`children` is auto-wired from `inputMap`** during hydrate — don't maintain both by hand.
- **Keys must be non-empty strings without whitespace.** Validated in hydrate.

---

## Minimum working example template

```ts
import { runtime } from "plastron";
import type { DehydratedCel, LambdaMetadata, FnRegistry } from "plastron/state";

// 1. Segment definitions — Record<Key, DehydratedCel>.
const mySegment: Record<string, DehydratedCel> = {
  input1: { segment: "demo", v: 0 },
  input2: { segment: "demo", v: 0 },
  sum:    { segment: "demo", f: "+(@input1, @input2)" },
  output: { segment: "demo", l: "myLambda", inputMap: { x: "sum" } },
};

// 2. Custom lambdas (skip if only using built-in ops).
const myLambda = ({ x }: { x: number }) => x * 2;
const fns: FnRegistry = { myLambda };
const meta: Record<string, LambdaMetadata> = {
  myLambda: {
    key: "myLambda",
    description: "doubles x",
    inputSchema: "unopInput", outputSchema: "number", arity: 1,
    source: myLambda.toString(),
  },
};

// 3. Boot. Primed and ready.
const rt = await runtime([mySegment], [meta], fns);

// 4. Use.
await rt.input!.batch([["input1", 3], ["input2", 4]]);
console.log(rt.input!.get("output"));   // 14

// 5. Add more segments later:
await rt.hydrate([anotherSegment], [anotherMeta], anotherFns);

// 6. Burn a segment:
rt.flush("demo");
```
