# DESIGN.md — designing with plastron

How to scope a project so plastron is the substrate, not garnish. Read this before writing code if you're starting something with plastron. Use it as a review rubric on existing work.

API reference lives in **SKILL.md**. Concrete patterns live in **COOKBOOK.md**.

---

## Two tracks

The first question to settle: **am I building an app or a segment?**

| | Plastron APP | Plastron SEGMENT |
|---|---|---|
| Output | A runnable thing (CLI, web app, demo) | A reusable library that mutates a State |
| Lives under | `examples/` or a separate repo | `segments/` |
| Boot code | `createInitialState()` + `installX(...)` + hydrate your cels | Exports an `installX(state, options)` function |
| State ownership | Creates and owns one State | Mutates a State the caller owns |
| Manifest | None (or the host's app manifest) | Required — declares deps, version, what it registers |
| Teardown | Process exits | `flush(state, segmentKey)` reclaims everything |

The tracks share idioms (cels, channels, formulas) but the **design checks differ**. Don't mix them up.

---

## When to reach for plastron at all

Plastron is the right substrate when:

- **There are dependencies.** Values that derive from other values, where you'd otherwise write `useEffect`s or invalidate caches by hand.
- **Recompute order matters.** You'd otherwise hand-sequence updates or fight stale state.
- **The data shape outlives any one runtime.** You want to save the graph to disk, load it elsewhere, and have it work — archives over JSON dumps.
- **You want change detection and diffing as a primitive,** not something each consumer reinvents.

It's overkill when:

- The whole app is one or two values with no dependencies. Use a plain variable.
- You need real-time multi-user collaboration. Plastron is not a CRDT.
- The work is mostly imperative orchestration (scripts, build tools).

If plastron is right, **default to plastron-first**. The state IS the app. The host (React, plastron-dom, plain DOM, a CLI) is a mount point that observes channels and writes inputs.

---

## First design rule: cels mark reactivity boundaries

Plastron-first does **not** mean "everything is a cel." It means **the state is a plastron State**. Within that, cel granularity is its own design lever — possibly the most important one.

> **Make a thing a cel when reactivity buys you something. Don't make it a cel just because it's "data."**

Every cel costs:
- A slot in `state.cels`
- A row in the downstream map (`buildDownstream` recursion target)
- Per-firing cascade machinery (`affectedFor`, topo walk)
- A formula codegen closure if formula-typed (~1640 B per cel)

That cost purchases the ability to observe this slot independently, mutate it and have only-its-downstream recompute, serialize it in a segment, or bind a side-effect channel to *this* slot. **If you don't need any of those, the cel is overhead.**

### Make it a cel when AT LEAST ONE is true

1. **You need to observe its changes independently** — a channel binds to it, a UI subscription binds to it, a downstream formula in a separate segment binds to it.
2. **Other cels' formulas reference it by name** — and you don't want them duplicating the compute.
3. **You want persistence-per-slot** — cels serialize into segments; sub-fields of a single cel's value do not.
4. **You want partial invalidation** — changing this slot should recompute only its downstream, not everything sharing a parent blob.
5. **You want lock / tag / ref / channel semantics on it** — those attach per-cel.

### Make it NOT a cel — keep it inside a native fn or closure — when

1. **It's an intermediate result only the surrounding compute reads.** Inner-loop accumulators, scratch arrays, RNG state. Putting these in cels makes them visible to the cascade machinery for no reactivity benefit.
2. **It's static configuration.** Wiring tables, dep lists, seeds. Capture in a closure when building the segment.
3. **It changes together with others and is only read together with them.** A 10k-element vector always updated and always read as one unit is **one cel holding a `Float64Array`**, not 10k scalar cels.
4. **The cost of reactivity on this slot exceeds the value of observing it.** A cel nobody subscribes to is just slow storage.

### The "cels-for-cels'-sake" antipattern

Recognizable by: a `for` loop builds N cels with formulas referencing prior-iteration cel keys; the N cels are never read individually, only as a group, after one input change; the caller reads the final aggregate via one cel.

**Fix**: collapse the inner work into one **native-fn cel**; keep cels only at the I/O boundaries (the inputs you mutate, the outputs anything else observes). This is "the one-cel pattern" — see COOKBOOK §2a.

### Evidence

The cellx benchmark, expressed three ways at the same workload (width=1000, 5000 logical nodes):

| variant | cel count | per-tick p50 |
|---|---|---|
| `cellx.plastron.ts` (one cel per node) | 5000 | 354 μs |
| `cellx.react-memo.ts` (idiomatic React, lifted state + `useMemo`) | 1 (logical) | 142 μs |
| `cellx.plastron-onecel.ts` (input cel + native-fn cel + output cel) | 3 | **97.7 μs** |

The 3.4× gap between the two plastron variants is **pure cels-for-cels'-sake overhead** — same inner compute, different cel topology. The one-cel plastron beats react-memo because plastron's one-cel cascade has less ceremony than React's render commit + `act()` flush + effect schedule.

Full discussion: `bench/RESULTS.md` and `notes/plastron-design-lessons.md`.

### Plastron-first, but reactivity-purposefully

When asked to build something with plastron, the right working sequence is:

1. **Identify the I/O boundaries.** What does the user (or upstream system) write? What does the host (or downstream system) observe? These are cels.
2. **Identify intermediate observation needs.** Anything a *separate* part of the graph reads independently is a cel. Anything an external channel watches is a cel.
3. **Everything else stays inside a native fn.** Loops, accumulators, scratch — JS, not cels.
4. **Then** pick segments, manifests, host. (See the two tracks below.)

If you find yourself sketching one cel per row of a table, one cel per pixel of a grid, one cel per amortization period — stop. Ask whether any of those are independently observed. Usually they're not, and the right shape is one input cel, one native-fn cel doing the loop, one output cel (or per-aggregate output cels).

The principle is sharp enough to be the **first rule** of plastron design. Apply it before everything else in this document.

---

## Track A — designing a plastron APP

### The shape

```
host code (host owns I/O bridges only)
   │
   ├── createInitialState()
   │
   ├── installX(state, opts) for each segment with side effects
   │    (registers channels, schemas, lambdas)
   │
   ├── hydrate(state, [yourSegment], [yourFns])
   │    your domain cels — the actual app
   │
   ├── runCycle(state)               // prime
   │
   ├── precomputeOptional(state)     // codegen fast path (~10× cascade speedup)
   │
   ├── installDom(state, {roots})    // or other output channel(s)
   │
   ├── runCycle(state)               // first paint
   │
   └── handle.channel.drain()        // flush sync
```

This sequence appears in `examples/plastron-sheet/src/main.ts`, `examples/plastron-spa-demo/src/main.ts`, `examples/fetch-demo/src/index.ts`. It's canonical — deviations should be deliberate.

**Use `batch` whenever a tick produces more than one write.** Calling `set` in a loop runs a full cascade per call — measured 14× regression in the Game of Life bench at 20×20 (`bench/RESULTS.md`). The fix is one `batch(state, [[k1, v1], [k2, v2], …])` call.

### What the host owns vs what plastron owns

| Host owns | Plastron owns |
|---|---|
| Mount points (`document.getElementById`, root component) | Tree cels that produce the vnode/output |
| Listeners that translate to `set` calls (clicks, keypresses, hashchange) | Every value that downstream cels depend on |
| Network/file I/O bridges that call lambdas or write cels | Fetch/file content as cel values, derived state |
| Process lifecycle (start, shutdown) | Cascade lifecycle (hydrate, runCycle, flush) |

The host's job is to mediate the boundary. Anything **inside** the boundary belongs in cels.

### Where cels come from

Three sources, listed in increasing distance:

1. **Literal in code.** Best for app structure that doesn't change at runtime. The "shell" segment of a SPA. See `examples/plastron-spa-demo/src/shell.ts`.
2. **Imported from an archive (`.甲`).** Best for content (articles, documents) that's authored once and rehydrated many times. `importArchive(bytes)` → `hydrate(state, segments)`. See `segments/plastron-archive`.
3. **Built at runtime by user action.** Lazy-loaded segments via dynamic import. See `examples/plastron-spa-demo` — `load()` returns a segment, the router hydrates on match.

Mixing is fine: shell in code, user content from an archive, on-demand features lazy-loaded.

### Anti-patterns for apps

**❌ App data in `useState` / module variables; plastron decorates.**
If you're tempted to write `const [items, setItems] = useState([])` for app data, that data should be a cel. The React component reads it through a host-side hook that subscribes to channel updates.

**❌ Computing values in event handlers.**
The handler should call `set(state, "input", v)`. The value that depends on it is a downstream cel. The handler doesn't compute anything — it injects an input.

**❌ Fetching then `setData`.**
A fetch result is a cel value. Either a `plastron-fetch` cel whose lambda performs the request, or a host-side fetch that ends with `set(state, "response", body)`. Not "fetch into local state; reflect into plastron later."

**❌ Manual reconciliation between host state and cel state.**
If you find yourself writing code to sync the two, the host is duplicating the graph. Lift the data into cels and have the host read through one channel.

**❌ `runtime()` / `plastron()` / `state.input`.**
These don't exist. Look up core fns by name on `state.fns`. (Old skill documented them; the API moved.)

**❌ N sequential `set` calls when one `batch` would do.**
Each `set` runs a full cascade — including affected-set computation and downstream walk. Coalesce writes via `batch(state, [[k, v], …])`. This is the single biggest authoring-time perf trap; the Life bench measured 14× from this one change.

**❌ Skipping `precomputeOptional(state)` after `runCycle`.**
Without it the kernel uses the AST-walk slow path on every fire. Always call it once after boot.

**❌ Confusing channels with write batching.**
Channels coalesce *outbound* side effects (DOM paint, IDB transaction). For *inbound* write coalescing on the way into the graph, use `batch`. Two different machineries; both useful; not interchangeable.

### Review rubric — apps

When reviewing an example or a new app, check:

- [ ] **Cel granularity earns its keep.** Every cel either is independently observed, persisted per-slot, or partially invalidated. No `for`-loop cel construction whose output is only read in aggregate.
- [ ] Boot sequence matches the shape above: `createInitialState` → `install*` for side-effect segments → `hydrate` → `runCycle` → **`precomputeOptional(state)`** → mount channel → `runCycle` → `drain`.
- [ ] Ticks that produce more than one write use `batch`, never a `set` loop or `Promise.all([set, set, …])`.
- [ ] No app-state `useState` / module-scope vars holding values that have downstream consumers.
- [ ] Event handlers call `set` / `batch` only — no value computation in the handler.
- [ ] Data fetches surface as cel values, not as imperative `setX` calls flowing into React state.
- [ ] There's exactly one State per logical session — not one per component.
- [ ] Output (DOM, terminal, file) is driven by a channel, not by reading cels in a `setInterval`.
- [ ] Workload doesn't depend on a linear chain past ~5000 cels (kernel `buildDownstream` stack limit).

---

## Track B — designing a plastron SEGMENT

### Three flavors of segment

Not every package under `segments/` registers state side effects. Pick the flavor honestly.

#### B1 — Pure helper (no `install` function)
Exports utility functions that take and return data. No state mutation. Examples: `plastron-archive` (`exportArchive`/`importArchive`), `plastron-chart` (`barChart(opts)`), `plastron-pdf`, `plastron-xlsx`.

These are libraries that happen to live in `segments/` because they collaborate with the cel format. They don't need a manifest (though one is fine for discoverability) and don't have a teardown.

#### B2 — Pure registrations (install schemas / lambdas / tags)
Exports `installX(state)` that adds schemas, lambdas, or tag handlers, but no channel and no managed cels. Examples: `plastron-collections`, `plastron-mjml`, `plastron-browser-file-io`.

Pattern from `segments/plastron-collections`:
- One idempotent `installCollections(state)` function.
- Direct `state.schemas.set` / `state.tagRegistry.set` for registrations.
- `hydrate` call with `fnMetaData` for lambdas (so the kernel auto-registers and locks them).
- Manifest declares `provides: { schemas, lambdas, tags, celSegments }`.

#### B3 — Full segment (install + channel + manifest + teardown)
Owns at least one channel. Has a clear lifecycle. Reference shape: `segments/plastron-dom`.

Pattern from `segments/plastron-dom/src/index.ts`:
1. Export `installX(state, options): Handle`.
2. Refuse to double-register: check `state.channelRegistry.has(channelKey)`.
3. Register schemas/metadata via `state.schemas.set` and `state.schemaMetadata.set` before hydrate (so auto-wire materializes `_isChanged` / `_diffFn` on cels).
4. Build the channel handler and register it in `state.channelRegistry`.
5. Hydrate the segment's managed cels (patch cels, lambdas, manifest).
6. Add a **sentinel cel** with a `_dispose` callback. `flush(state, segmentKey)` fires `_dispose` → channel tears down → registry entry removed.
7. Return a handle (channel + key references) for hosts that want introspection or manual drain.

Variants live in the tree — examples are not deviations to copy by default, just acknowledged:
- `plastron-fetch`, `plastron-idb`, `plastron-routes` — same shape as plastron-dom.
- `plastron-sheet` — also swaps the kernel's `f` compiler. Drift only if you must replace a core fn.
- `plastron-idb` — async `installIdb` returns a Promise. Drift only if open() is genuinely async.
- `plastron-routes` — manual `handle.dispose()` instead of sentinel cel. Either works.

### Manifest hygiene

```ts
export const myManifest: SegmentManifest = {
  segment: "my-segment",            // matches Segment.key and cel.segment values
  version: "1.0.0",                 // semver — used for satisfies() checks
  description: "What it does.",
  dependsOn: [                      // omit if none
    { segment: "plastron-archive", semver: "*" },
  ],
  provides: {
    lambdas:     [...],
    schemas:     [...],
    channels:    [...],
    celSegments: [...],             // every cel.segment value this owns
  },
};
```

**Why `provides` matters:** `flush` walks `provides` to know what to unregister. `findDependents` uses it to warn before flushing a segment something else depends on. Skip it and teardown leaks.

### Anti-patterns for segments

**❌ Side effects at module load.**
`installX(state, …)` is the only side-effect entry point. The module itself just defines functions and types. Imports don't mutate anything.

**❌ Storing state outside `state.cels` / `state.channelRegistry`.**
Module-scope variables that hold per-call state break multi-State setups (e.g. tests, multiple painters). Use a `WeakMap<State, …>` if you need per-state memoization. See `segments/plastron-idb` for the canonical pattern.

**❌ Registering channels after cels that reference them.**
The kernel resolves `_channelHandlers` at precompute. Late-registered handlers silently miss already-hydrated cels.

**❌ Hardcoded channel key.**
Always accept `options.channelKey` (defaulting to a constant). Two installations in the same State (multiple DOM roots, multiple fetchers) need namespace.

**❌ No teardown path.**
If your segment registers any timer, listener, fetch, or worker, it MUST have a teardown (sentinel cel with `_dispose`, or a `handle.dispose()` method, or both). `flush(state, segmentKey)` is the user's only reclamation lever.

**❌ Missing or stale `provides`.**
The manifest lies about what gets registered → `findDependents` lies → flush leaks. Keep `provides` in sync.

### Review rubric — segments

When reviewing a segment, check:

- [ ] Which flavor (B1/B2/B3) does this claim to be? Does the file structure match?
- [ ] `installX(state, options?)` is the only state-mutating entry point (B2/B3).
- [ ] `SegmentManifest` exported with `version`, `description`, and `provides`. `dependsOn` listed honestly.
- [ ] If it owns a channel: registered before any cel referencing it is hydrated.
- [ ] If it owns a channel: there's a `dispose` path that cancels timers / detaches listeners / removes from `state.channelRegistry`.
- [ ] Idempotent: double-install either no-ops or throws a clear error. Doesn't corrupt state.
- [ ] No module-scope mutable state. Per-state memoization uses `WeakMap<State, …>`.
- [ ] `flush(state, segmentKey)` actually leaves the state clean — channel gone, registries unchanged, no orphan cels.
- [ ] Schemas and lambdas registered with proper metadata (so auto-wire works on cels that opt in).
- [ ] `options.channelKey` (or equivalent) lets two installations coexist when relevant.

---

## Apps that compose segments

The interesting work is composing several segments in one State. A few rules:

- **Install in dependency order.** `installDom` after `installSheet` (sheet's tree cel is what dom mounts). The manifest's `dependsOn` makes this explicit — read it.
- **One `runCycle` after segments are loaded, before the channel mounts.** This primes lambda cels so the first paint has values to diff against.
- **A second `runCycle` after `installDom`** triggers the first enqueue → drain → paint.
- **Don't reach across segments by raw cel key.** If two segments need to share state, the upstream segment should expose a stable cel key in its manifest's docstring and the downstream segment reads it. Cross-segment cel reads are a contract.

The reference example for multi-segment composition is `examples/plastron-spa-demo` — shell + dom-builders + router + lazy-loaded feature segments, all in one State.

---

## When in doubt

- If you can't say in one sentence what's a cel vs what's host code, you're not plastron-first yet — go back and list cels first.
- If your "segment" has no `install` function and no manifest, it's a B1 helper. That's fine, but don't pretend otherwise.
- If your segment's flush leaves cruft, fix the teardown before adding features.
- If two examples diverge on boot sequence, the older / simpler one is usually right.
