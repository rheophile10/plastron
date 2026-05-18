# COOKBOOK.md — concrete plastron patterns

Recipes grounded in the existing `examples/` and `segments/`. Each pattern cites the file you can copy from. Use this when you know *what* you're building and need to remember *how* to do a specific thing.

For project shape see **DESIGN.md**. For API reference see **SKILL.md**.

---

## 1. Boot a plastron app

The canonical sequence. Copy verbatim, swap segments for what you need.

```ts
import { createInitialState, precomputeOptional, type Fn } from "plastron";
import { installDom } from "plastron-dom";

const state = createInitialState();
const hydrate  = state.fns.get("hydrate")  as Fn;
const runCycle = state.fns.get("runCycle") as Fn;

// 1. Install side-effect segments BEFORE hydrating cels that reference them.
await hydrate(state, [yourSegment], [yourFns]);
await runCycle(state);
await precomputeOptional(state);   // codegen fast path — ~10× cascade speedup

// 2. Mount output channel (DOM or otherwise) AFTER cels exist.
const handle = installDom(state, {
  roots: { app: { selector: "#root", cel: "appTree" } },
});

await runCycle(state);            // first paint
await handle.channel.drain();     // flush sync
```

`precomputeOptional` is async — it builds per-cel `_evaluate` closures that read deps via inline property access. Without it, every fire walks the AST against resolved cels. Always call once after `runCycle`.

Reference: `examples/plastron-sheet/src/main.ts:19-29`, `examples/plastron-spa-demo/src/main.ts:20-54`, `notes/plastron-authoring-lessons.md`.

---

## 1a. The one-cel pattern — cels at I/O boundaries only

Before defining cels, ask: **which slots actually need reactivity?** Per-cel reactivity costs cascade machinery on every fire. If a chunk of work has one input and one observable output, give it one input cel, one native-fn cel, one output cel — even when the inner work touches 10,000 values.

```ts
// ❌ "Cels-for-cels'-sake" — N cels for N intermediate balances no one
//    observes individually. Cascade walks all N every tick.
const cels: DehydratedCel[] = [
  { key: "rate", segment: "loan", v: 0.06/12 },
  { key: "payment", segment: "loan", v: 599.55 },
  { key: "balance_0", segment: "loan", v: 100000 },
];
for (let i = 1; i < 360; i++) {
  cels.push({
    key: `balance_${i}`, segment: "loan",
    f: `(- (* balance_${i-1} (+ 1 rate)) payment)`,
  });
}

// ✓ The one-cel pattern — three cels, one native fn does the whole loop.
//   I/O boundaries are reactive; intermediates are JS.
const amortize = ({ principal, rate, payment, n }:
  { principal: number; rate: number; payment: number; n: number }) => {
  let bal = principal;
  const balances = new Float64Array(n + 1);
  balances[0] = bal;
  for (let i = 1; i <= n; i++) {
    bal = bal * (1 + rate) - payment;
    balances[i] = bal;
  }
  return balances;
};

const loanSegment: Segment = {
  key: "loan",
  cels: [
    { key: "principal", segment: "loan", v: 100000 },     // input
    { key: "rate",      segment: "loan", v: 0.06/12 },    // input
    { key: "payment",   segment: "loan", v: 599.55 },     // input
    { key: "n",         segment: "loan", v: 360 },        // input
    { key: "balances",  segment: "loan", l: "amortize",   // observable output
      inputMap: { principal: "principal", rate: "rate", payment: "payment", n: "n" } },
  ],
  fnMetaData: { amortize: { key: "amortize", inputSchema: "object",
    outputSchema: "object", arity: 4, source: amortize.toString() } },
};
```

Measured (`bench/RESULTS.md`):

| variant | cel count | per-tick p50 (N=1000) |
|---|---|---|
| per-cel plastron | 1004 | 409 μs |
| react-memo (lifted state + `useMemo`) | 1 (logical) | 61 μs |
| **one-cel plastron** | 5 | **15.8 μs** |

**26× speedup over per-cel plastron, 4× over react-memo.** Same inner compute — the gap is the cel topology.

**When to use:** any time the inner work has no independent observation needs. Heuristic — if a `for` loop builds N formula cels whose outputs are only read in aggregate, collapse the loop into a native fn.

**When NOT to use:** if the user can edit individual `balance_i` values mid-flow, the per-cel form is right (each cell is independently writable + observable). The shape of the cels follows the shape of the *observation contract*, not the shape of the math.

See **DESIGN.md** "First design rule: cels mark reactivity boundaries" for the full criteria. Reference: `bench/src/benches/cellx.plastron-onecel.ts`, `notes/plastron-design-lessons.md`.

---

## 2. Define cels with formulas + lambdas

```ts
const formatLabel = ({ total }: { total: number }) => `$${total.toFixed(2)}`;

const cartSegment: Segment = {
  key: "cart",
  cels: [
    { key: "price", v: 100, segment: "cart" },
    { key: "qty",   v: 3,   segment: "cart" },
    { key: "total", segment: "cart", f: "(* price qty)" },                    // formula
    { key: "label", segment: "cart", l: "formatLabel", inputMap: { total: "total" } }, // lambda
  ],
  fnMetaData: {
    formatLabel: { key: "formatLabel", inputSchema: "object", outputSchema: "string",
                   arity: 1, source: formatLabel.toString() },
  },
};
await hydrate(state, [cartSegment], [new Map([["formatLabel", formatLabel]])]);
```

Formulas (`f`) compile via the kernel's `f` lambda — S-expression syntax, with only `+ - * /` as builtins. Bare symbols (`price`, `qty`) auto-wire to upstream cels. Lambda cels (`l`) call a named fn directly via `inputMap`.

For non-arithmetic operations in formula syntax, register a **native-fn cel** — see pattern #3a below.

---

## 3. Custom lambda — define on the segment

```ts
const sumLineItems = ({ p, q }: { p: number[]; q: number[] }) => {
  let t = 0;
  for (let i = 0; i < p.length; i++) t += p[i] * (q[i] ?? 0);
  return t;
};

const segment: Segment = {
  key: "cart",
  cels: [
    { key: "total", segment: "cart", l: "sumLineItems",
      inputMap: { p: "prices", q: "quantities" } },
  ],
  fnMetaData: {
    sumLineItems: {
      key: "sumLineItems",
      description: "Element-wise dot product.",
      inputSchema: "object", outputSchema: "number",
      arity: 2, source: sumLineItems.toString(),
    },
  },
};
await hydrate(state, [segment], [new Map([["sumLineItems", sumLineItems]])]);
```

Reference: `examples/fetch-demo/src/index.ts:68-91`.

---

## 3a. Native-fn cel — non-arithmetic operations in formulas

The formula compiler only knows `+ - * /`. Everything else (comparisons, `if`, `min`, `max`, `pow`, string ops, anything domain-specific) becomes a **native-fn cel**: a cel whose `v` is a JS function. Reference its key as the list head in any formula.

```ts
const lifeSegment: Segment = {
  key: "life",
  cels: [
    // Native-fn cel — JS function as a value.
    { key: "nextOf", segment: "life",
      v: (neighborSum: number, current: number) =>
           (neighborSum === 3 || (neighborSum === 2 && current === 1)) ? 1 : 0 },

    // 8-neighbor cells (only one shown).
    { key: "p44", segment: "life", v: 0 },
    /* … p45 … p66 … */

    // Formula references the fn as the list head; arithmetic stays builtin.
    { key: "cell_5_5", segment: "life",
      f: "(nextOf (+ p44 p45 p46 p54 p56 p64 p65 p66) p55)" },
  ],
};
await hydrate(state, [lifeSegment], []);
```

Why this over a lambda cel:
- The fn lives in the State, so it survives `dehydrate` (function `toString()` round-trips).
- Cells can be live-edited at runtime — `setCel(state, "nextOf", { v: newFn })` and every dependent formula picks it up next cascade.
- No metadata table to maintain.

Use a lambda cel (`l:` + `fnMetaData`) when the same function is shared across many cels and you want one registered metadata record. Use a native-fn cel when it's one-off, domain-specific, or you want the function to be data.

Reference: `bench/src/benches/life.plastron.ts`, `notes/plastron-authoring-lessons.md` ("The big ones" §2).

---

## 3b. Many writes per tick — use `batch`, never a `set` loop

This is the single biggest plastron performance trap. Every `set` runs a full cascade. N sequential sets = N cascades.

```ts
// ❌ WRONG — N cascades, N× too slow
for (const [k, v] of writes) await set(state, k, v);

// ❌ ALSO WRONG — Promise.all doesn't help; each set still kicks its own cascade
await Promise.all(writes.map(([k, v]) => set(state, k, v)));

// ✓ RIGHT — one cascade for the union
await batch(state, writes);
```

Measured impact (Game of Life, 20×20 grid):
- N sequential `set` per tick: **6.20 ms/gen**
- One `batch` per tick: **0.44 ms/gen**
- Speedup: **14×**

The lesson: if a tick produces more than one write, it wants `batch`. Almost always.

`batch` dedups firedKeys (so writing the same key twice fires once) and runs `runCascade` on the union of affected closures. v1 makes no ordering guarantee beyond array order — fine for independent cells, watch for ref-slot collisions on the same source.

Reference: `plastron/src/core/input.ts:169`, `bench/src/benches/life.plastron.ts`, `bench/RESULTS.md` § "life".

---

## 4. Dehydrate a State to a `.甲` archive

For saving to disk, posting to a server, embedding in SQLite, or shipping as a download.

```ts
import { exportArchive, importArchive } from "plastron-archive";

const dehydrate = state.fns.get("dehydrate") as Fn;

// Round-trip:
const segments = dehydrate(state);                            // Segment[]
const bytes    = await exportArchive(segments, {});           // Uint8Array

// later, fresh state on the same or different host:
const next = createInitialState();
const { segments: incoming } = await importArchive(bytes);
const nextHydrate = next.fns.get("hydrate") as Fn;
await nextHydrate(next, incoming, []);
```

`dehydrate` drops runtime-only fields (`_fn`, `_inputEntries`, `_diff`) and filters out reserved segments (`core`, `stats`). User cels — including custom-lambda `fnMetaData` and schema keys — round-trip.

The archive does NOT include channel handler implementations or fn closures. Re-run `installX(state, …)` on the receiving side BEFORE rehydrating cels that bind to channels.

Reference: `segments/plastron-archive/src/export.ts:50`, `segments/plastron-archive/src/import.ts:30`. Used by `examples/plastron-cms` and `segments/plastron-sqlite`.

---

## 5. Build a custom channel

**Don't confuse channels with write batching.** Channels coalesce *outbound* side effects (DOM paint, IDB transaction, network commit). For *inbound* write coalescing on the way into the graph, use `batch` (pattern #3b). Two different machineries.

Channels are arbitrary side-effect sinks. Implement four methods:

```ts
import type { ChannelHandler, Cel, State } from "plastron";

const buildLogChannel = (label: string): ChannelHandler => {
  const queue: Cel[] = [];
  return {
    enqueue: ({ cel }) => { queue.push(cel); },
    hasPending: () => queue.length > 0,
    drain: () => {
      for (const cel of queue) console.log(`[${label}]`, cel.key, "→", cel.v);
      queue.length = 0;
    },
    dispose: () => { queue.length = 0; },
  };
};

state.channelRegistry.set("log", buildLogChannel("log"));

// any cel bound to this channel will route on change
await hydrate(state, [{
  key: "audit",
  cels: [{ key: "x", v: 0, segment: "audit", channel: "log" }],
}], []);

await set(state, "x", 42);
await drain(state, "log");        // [log] x → 42
```

The kernel hands the channel `cel.v` (new value) and `cel._diff` (if a `_diffFn` is attached — see #6).

Choose a commit schedule:
- **Sync** — drain inside `enqueue`. Useful for tests.
- **Microtask** — schedule via `queueMicrotask` so multiple writes in one cascade coalesce.
- **rAF** — `requestAnimationFrame`. Used by `plastron-dom`.
- **Debounce** — `setTimeout(..., debounceMs)`. Used by `plastron-fetch`'s observation channel.

Reference: `segments/plastron-dom/src/paint.ts` (rAF), `segments/plastron-fetch/src/index.ts` (debounce + onCommit hook), `segments/plastron-idb/src/install.ts` (debounce + transaction batching).

---

## 6. Diffing — channels that emit patches, not full values

The plastron change pipeline:

1. Cel declares a `schema: zodType`.
2. Schema metadata names an `isChanged` lambda and a `diff` lambda.
3. Hydrate auto-wires `cel._isChanged` and `cel._diffFn`.
4. After the cel's lambda fires, `runCascade` calls `_isChanged(prev, next)`.
5. If true, calls `_diffFn(prev, next)` and stores result on `cel._diff`.
6. Routes to channels — handler reads `cel._diff` instead of recomputing.

Set up:

```ts
import { z } from "zod";

const docSchema = z.object({ title: z.string(), body: z.string() });

// Schema metadata names the change/diff fn keys.
state.schemas.set("doc", docSchema);
state.schemaMetadata.set("doc", {
  key: "doc",
  isChanged: "docIsChanged",
  diff:      "docDiff",
});

// Register the actual diff/change fns.
state.fns.set("docIsChanged", (prev, next) =>
  prev?.title !== next?.title || prev?.body !== next?.body);
state.fns.set("docDiff", (prev, next) => ({
  title: prev?.title === next?.title ? undefined : next?.title,
  body:  prev?.body  === next?.body  ? undefined : next?.body,
}));

// Cel opts in via schema.
await hydrate(state, [{
  key: "view",
  cels: [{ key: "doc", v: { title: "Untitled", body: "" }, schema: docSchema,
           segment: "view", channel: "persist" }],
}], []);
```

The channel handler then reads patches, not full values:

```ts
const persistChannel: ChannelHandler = {
  enqueue: ({ cel }) => pending.set(cel.key, cel._diff),     // patch, not v
  hasPending: () => pending.size > 0,
  drain: async () => {
    for (const [key, patch] of pending) await sendPatch(key, patch);
    pending.clear();
  },
  dispose: () => pending.clear(),
};
```

Reference: `segments/plastron-dom/src/vnode.ts` (vnode schema + `vnodeEquals` + `diffVNodes`), `segments/plastron-dom/src/index.ts:138-247` (full wire-up).

---

## 7. Persist to storage on a debounce

The `plastron-idb` pattern: a channel that batches writes and commits them as one transaction.

```ts
import { installIdb } from "plastron-idb";

const inst = await installIdb(state, {
  database: "myApp", version: 1, debounceMs: 100,
});

// Any cel with channel: inst.channelKey is auto-persisted.
await hydrate(state, [{
  key: "notes",
  cels: [
    { key: "note_0", v: "draft", segment: "notes", channel: inst.channelKey },
    { key: "note_1", v: "draft", segment: "notes", channel: inst.channelKey },
  ],
}], []);

// 100 writes in a tight loop coalesce into one IDB transaction.
for (let i = 0; i < 100; i++) await set(state, "note_0", `revision ${i}`);
await drain(state, "all");        // forced sync flush for tests / shutdown
```

Reference: `examples/idb-persistence-demo/src/index.ts:62-128`.

For Postgres or another backing store, follow the same shape: an installer that owns the connection, registers a debounced channel, and tears down on flush.

---

## 8. Fetch as a cel

```ts
import { installFetch, FETCH_JSON_KEY } from "plastron-fetch";

installFetch(state);

await hydrate(state, [{
  key: "users",
  cels: [
    { key: "userRequest", v: { url: "https://api.example.com/users/1", method: "GET" },
      segment: "users" },
    { key: "userResponse", segment: "users", l: FETCH_JSON_KEY,
      inputMap: { request: "userRequest" }, channel: "fetch" },
    { key: "userName", segment: "users", f: "@(@userResponse, 'body.name')" },
  ],
}], []);

await set(state, "userRequest", { url: "...", method: "GET" });
// userResponse fills in, userName derives, channel observes.
```

The fetch lambda is async; cascade awaits it. Errors land on the response cel's `.error` field, not as exceptions.

Reference: `examples/fetch-demo/src/index.ts:68-115`.

---

## 9. Observe commits without owning the channel (debug / telemetry)

Register a second channel handler on the same cels. `cel.channel: ["domain", "audit"]` fans out.

```ts
const auditChannel: ChannelHandler = {
  enqueue: ({ cel }) => audit.push({ key: cel.key, v: cel.v, t: Date.now() }),
  hasPending: () => false,
  drain: () => {},
  dispose: () => {},
};
state.channelRegistry.set("audit", auditChannel);

// Now bind cels to both.
{ key: "x", v: 0, segment: "domain", channel: ["domain", "audit"] }
```

Or, if you can't change `cel.channel`, use `createFetchChannel({ onCommit })`-style hooks where segments provide them. The `plastron-fetch` segment exposes this directly:

```ts
const obs = createFetchChannel(state, {
  debounceMs: 10,
  onCommit: (celKey, value) => observed.push({ key: celKey, ...value }),
});
state.channelRegistry.set("fetch:observed", obs);
```

Reference: `examples/fetch-demo/src/index.ts:179-218`.

---

## 10. Bridge React (or any host) into a plastron State

The boundary discipline: **host writes inputs, host reads outputs via a channel**. No mid-tier "shadow copy" of cels in component state.

```tsx
// useCelValue.ts — a hook that subscribes via a tiny per-component channel.
import { useEffect, useState } from "react";
import type { State, Fn } from "plastron";

export const useCelValue = <T,>(state: State, key: string): T => {
  const get = state.fns.get("get") as Fn;
  const [v, setV] = useState<T>(() => get(state, key) as T);

  useEffect(() => {
    const channelKey = `react:${key}:${Math.random()}`;
    state.channelRegistry.set(channelKey, {
      enqueue: ({ cel }) => { if (cel.key === key) setV(cel.v as T); },
      hasPending: () => false,
      drain: () => {},
      dispose: () => {},
    });

    // Patch the cel to add this channel (or wire it up front in the segment).
    const cel = state.cels.get(key);
    const prev = cel?.channel;
    if (cel) cel.channel = Array.isArray(prev) ? [...prev, channelKey] : prev ? [prev, channelKey] : channelKey;

    return () => {
      if (cel) cel.channel = prev;
      state.channelRegistry.delete(channelKey);
    };
  }, [state, key]);

  return v;
};
```

The component writes inputs via `set(state, key, v)` directly. There's no `useReducer`, no `context`, no shadow.

For a more structured bridge see `examples/plastron-cms/src/PlastronCMS.tsx` — but note its title/description ARE in React state, which is a partial drift (could be cels). The body content is properly plastron-owned.

For a no-React option, `plastron-dom` IS the host: `installDom(state, { roots })` mounts a vnode-producing cel directly.

---

## 11. Ingest a segment at runtime (lazy / on-demand loading)

```ts
// Pattern: a route handler imports a segment module and hydrates on demand.
const loadFeature = async (state: State, name: string) => {
  const mod = await import(`./features/${name}.js`);
  const segment = mod.buildSegment();
  await hydrate(state, [segment], mod.fns ?? []);
  await runCycle(state);
};

// First-time visit triggers the load; subsequent visits no-op (hydrate
// is incremental; identical cels with `locked: true` are not overwritten).
```

For routing, `plastron-routes` handles this directly — the route definition's `load()` returns a segment, the router hydrates on match.

Reference: `examples/plastron-spa-demo/src/main.ts:36-44` (counter and weather are lazy-loaded segments).

To unload: `flush(state, segmentKey)`. Fires `_dispose` on every cel in the segment, removes the manifest entry, leaves the rest of the state intact.

---

## 12. Tear down a segment cleanly

```ts
const flush = state.fns.get("flush") as Fn;
flush(state, "plastronDom");      // remove DOM painter cels + channel + listeners
flush(state, "users");            // drop the users segment

console.log(state.channelRegistry.has("plastronDom"));  // false
```

For this to work, your segment must:
1. Have a sentinel cel with `_dispose` that calls `channel.dispose()` and `state.channelRegistry.delete(channelKey)`.
2. List its `provides.channels` honestly in the manifest, so `findDependents` knows what depended on it.

Reference: `segments/plastron-dom/src/index.ts:253-262`, `segments/plastron-fetch/src/index.ts:202-211`.

---

## 13. Replace a cel's `f` / `l` atomically (live formula edit)

Use `setCel` (NOT `set` — which only writes `v`).

```ts
const setCel = state.fns.get("setCel") as Fn;
await setCel(state, "total", { f: "+(@price, @qty)" });   // was *(...)
```

`setCel` reruns precompute (the dep set may have shifted), so it's heavier than `set`. Batch with `setCelBatch` if changing many cels — precompute runs once at the end.

Reference: `plastron/src/core/input.ts:358-500`.

---

## 14. Manual cycles & buffered writes (advanced)

By default, every `set` / `batch` fires its own cascade. For testing or replay, you can buffer writes:

```ts
const consume = state.fns.get("consume") as Fn;

// queue writes without firing
state.cels.get("x")!.v = 1;       // bypass cascade
state.cels.get("y")!.v = 2;

await consume(state);              // drain pending → one cascade
```

Rare — most code wants the auto-cascade behavior of `set` / `batch`. Used for snapshot restore and time-travel debugging.

---

## 15. The "stats" segment — observe runtime telemetry

The kernel writes per-cycle stats to reserved cels. `dynamic: true` makes them refire each cycle, so any downstream lambda you write becomes a watcher.

```ts
import { STATS_CYCLES } from "plastron";

await hydrate(state, [{
  key: "watcher",
  cels: [{
    key: "lastCycleSize", segment: "watcher",
    l: "lastCycleSize",
    inputMap: { snap: STATS_CYCLES },
  }],
  fnMetaData: {
    lastCycleSize: {
      key: "lastCycleSize", inputSchema: "object", outputSchema: "number", arity: 1,
      source: "({snap}) => snap?.firedCount ?? 0",
    },
  },
}], [new Map([["lastCycleSize", ({snap}: {snap: {firedCount?: number}}) => snap?.firedCount ?? 0]])]);
```

Stats are filtered out at `dehydrate` so they don't bloat archives.

Reference: `plastron/src/core/perf.ts`.

---

## Patterns to avoid

(Cross-referenced with **DESIGN.md** anti-patterns.)

- **`set` loops or `Promise.all([set, set, …])` per tick.** Use `batch` (#3b). 14× perf cliff in real workloads.
- **Skipping `precomputeOptional`.** Without it, every formula fire walks the AST. ~10× difference.
- **Channels mistaken for write batching.** Channels are *outbound* coalescing; `batch` is *inbound*.
- **Mid-tier shadow state.** Don't keep cel values in component state, mirror them, and reconcile. Read through a channel; write through `set` / `batch`.
- **Manual `setInterval` polling.** If you're polling `state.cels.get(key).v`, you should be on a channel.
- **Module-scope mutable state in a segment.** Use `WeakMap<State, …>` for per-state caches.
- **Late channel registration.** Register channels before hydrating cels that reference them, or those bindings will silently miss.
- **Hardcoded channel keys in a segment.** Always accept `options.channelKey` so two installs can coexist.
- **Touching `state.cels.get(...).v` directly to write.** Use `set` / `batch`. Direct mutation skips cascades.
- **Linear chains past ~5000 cels.** Kernel `buildDownstream` stack overflow. Shape the workload differently or wait for the kernel fix.

---

## When in doubt

- The smallest working example you can find in `examples/` is usually the right starting template.
- Channel registrations and sentinel-cel teardowns live in the segment, not the app.
- If you're tempted to "just store this in React state for now," check whether anything else needs to react to it. If yes, it's a cel.
