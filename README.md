# plastron 🐢

A reactive computation kernel for TypeScript. Cels hold values or formulas; writing one triggers a cycle that recomputes every downstream cel in topological order.

Spreadsheet semantics, lifted out of the spreadsheet. The formula language is itself a swappable function in the registry, so you bring the syntax — the kernel only knows about cels, dependencies, and waves.

— Background on the project's name: [`plastromancy.md`](plastromancy.md).

## Why

Excel's reactive recalculation is one of the most successful end-user programming environments ever built — and it's locked inside one application. Plastron lifts the model out:

- Cels are typed JS values keyed by string.
- Formulas are first-class fns in a registry, looked up by key.
- The formula compiler itself is a fn at key `"f"` — replace it and you've changed the language.
- State is a flat record of maps. Hydrate from JSON segments, dehydrate back. No magic.

Small kernel, ~1.3k LOC. The interesting things (DOM rendering, archives, charts, polyglot kinds) live in `segments/`.

## Install

The package is currently consumed via workspace path imports. There is no published npm release yet.

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

// A segment is a JSON-shaped bundle of cels. price and qty hold values;
// total is a formula that references @price and @qty.
const demo: Segment = {
  key: "demo",
  cels: [
    { key: "price", v: 100,                       segment: "demo" },
    { key: "qty",   v: 3,                         segment: "demo" },
    { key: "total", f: "*(@price, @qty)",         segment: "demo" },
  ],
};

const state = createInitialState();
const hydrate  = state.fns.get("hydrate")!  as Fn;
const runCycle = state.fns.get("runCycle")! as Fn;
const get      = state.fns.get("get")!      as Fn;
const set      = state.fns.get("set")!      as Fn;

hydrate(state, [demo], []);   // load segments, compile formulas, wire deps
await runCycle(state);         // first cycle: total = 300

console.log(get(state, "total"));    // 300

await set(state, "qty", 4);          // schedule a write
await runCycle(state);                // cascade fires
console.log(get(state, "total"));    // 400
```

The kernel exposes itself through `state.fns` rather than free-standing exports. Every operation — `get`, `set`, `batch`, `touch`, `consume`, `hydrate`, `dehydrate`, `runCycle`, `flush` — is a fn in that map. Hosts replace any of them by passing a `Map<LambdaKey, Fn>` to `hydrate`. Built-in fns are lock-protected via `state.fnMetadata`.

## Cel shape

```ts
interface Cel {
  key:        string;
  v:          unknown;                              // current value
  l?:         string;                               // fn key — makes this cel computed
  f?:         string;                               // formula source — compiled to _fn at hydrate
  inputMap?:  Record<string, string | string[]>;   // named upstream deps
  segment?:   string;                               // which segment this cel belongs to
  schema?:    ZodType;                              // optional value schema
  wave?:      number;                               // scheduling wave (default 0)
  locked?:    boolean;                              // hydrate won't overwrite
  dynamic?:   boolean;                              // re-fires every cycle
  tag?:       string;                               // format-tag for opaque values
}
```

A formula cel is sugar for a lambda cel whose body is the parsed AST. At hydrate time, `f` is compiled by `state.fns.get("f")` into `cel._fn`, and `inputMap` is auto-wired from the formula's `@references`.

## Swap the formula language

The formula compiler is just an entry in `state.fns`:

```ts
const myFn: Fn = (src: string) => /* parse src, return a Fn */;
myFn.extractDeps = (src: string) => /* return [keys] referenced */;

hydrate(state, segments, [new Map([["f", myFn]])]);
```

After that every `cel.f` runs through your compiler instead of the default S-expression one.

## What's in segments/

Each is its own package; treat them as examples of how to extend the kernel rather than a stable ecosystem yet.

- `plastron-dom` — vnode schema + painter that mounts a cel tree to the DOM.
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

Each example has its own README and is run with `npm install && npm run dev` (or `npx tsx src/index.ts` for the node-only ones).

## Status

v0.0.0. The kernel is small and the API surface is still moving. Expect breakage. The current focus is reconciling the segment ecosystem and example apps with the simplified kernel.

## License

[MIT](LICENSE).
