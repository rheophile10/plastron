# CLAUDE.md — plastron repo

This is the plastron monorepo: a reactive DAG kernel (`plastron/`), a set of segments that extend it (`segments/`), and demo apps (`examples/`).

## Default to plastron-first

When asked to build something in this repo, the working assumption is **the State is the app**. Reach for cels and channels before useState/useReducer/module variables. The host (React, plastron-dom, plain DOM, CLI) is a mount point that observes channels and writes inputs — nothing more.

If you find yourself sketching a Node/React app with plastron "added later," stop. List the cels first.

**But plastron-first ≠ everything-is-a-cel.** Cels mark *reactivity boundaries*. Make something a cel only when reactivity buys you something: independent observation, channel binding, partial invalidation, per-slot persistence. Inner compute — loop accumulators, scratch values, things only read in aggregate — stays inside a native fn. Measured: collapsing N intermediate cels into one native-fn cel beats both per-cel plastron AND react-memo (`bench/RESULTS.md`). The first design rule in `DESIGN.md` is "what deserves its own cel" — read it before sketching cels.

Detailed guidance:
- `.claude/skills/plastron/SKILL.md` — API reference (cels, channels, fns)
- `.claude/skills/plastron/DESIGN.md` — project shape (app vs segment tracks), review rubric
- `.claude/skills/plastron/COOKBOOK.md` — concrete recipes with file:line cites

## These docs are point-in-time

The skill files and this CLAUDE.md were synthesized from a specific snapshot of the code and a specific set of bench results. They will drift. **Before relying on any specific claim** (a perf number, a "use X for Y" rule, an API shape, a sharp-edge warning), do a fast sanity-check against the current source of truth:

- `bench/RESULTS.md` — current benchmark numbers and framing.
- Recent `git log` on `plastron/src/` and `segments/` — API may have moved.

If you find a contradiction between a doc claim and the current source of truth, **flag it explicitly to the user** before acting on either, and propose the update. Don't silently follow the older doc. Don't silently follow the newer note without surfacing it. The skill files are meant to be edited as the project learns — staleness is a bug, not the cost of doing business.

Triggers for a sanity-check pass:
- Anything in the **Performance defaults** section below — perf claims rot fastest.
- The API anchors (`state.fns.get(...)` surface) — these moved once already (`runtime()` / `state.input` were removed).
- The "First design rule" framing in DESIGN.md — if a new bench family produces evidence that complicates the cel-granularity story, that's load-bearing.

## API anchors

There is no `runtime()`, no `plastron()`, no `state.input`. Stale docs may reference them; ignore. The current surface is:

```ts
import { createInitialState, precomputeOptional, type Fn } from "plastron";
const state = createInitialState();
const hydrate = state.fns.get("hydrate") as Fn;
const set     = state.fns.get("set")     as Fn;
const batch   = state.fns.get("batch")   as Fn;
const get     = state.fns.get("get")     as Fn;
const runCycle = state.fns.get("runCycle") as Fn;
```

State field is `state.cels` (lowercase). Channels register in `state.channelRegistry`.

**Formula syntax is S-expression.** `(* price qty)`, `(+ a b c)`. Only `+ - * /` are builtins. Everything else is a native-fn cel: a cel whose `v` is a JS function, referenced as the list head (`(myFn a b)`).

## Performance defaults

These are the rules from the bench-build lessons. Treat as non-negotiable unless you've measured otherwise:

0. **Cels mark reactivity boundaries.** Don't make something a cel unless reactivity buys something. Inner compute belongs in native fns. Amortization N=1000: 26× speedup from this one design choice. (See DESIGN.md "First design rule.")
1. **`batch` over `set`-in-a-loop.** Every `set` is a full cascade. Game of Life measured 14× from this one change.
2. **`precomputeOptional(state)` after `runCycle`.** Gates the codegen fast path. ~10× on cascade-shape benches.
3. **Native-fn cels for non-arithmetic** in formulas. The compiler only knows `+ - * /`.
4. **Cap linear chain depth at ~5000.** `buildDownstream` recurses; deeper chains overflow V8's stack.

## App vs segment

Two tracks, different rubrics. **Confirm which before designing.**

- **App** (under `examples/`): boot a State, install segments, hydrate domain cels, mount channels. Doesn't export a manifest.
- **Segment** (under `segments/`): exports `installX(state, options?)` and a `SegmentManifest`. Mutates a State the caller owns. Idempotent. Cleans up under `flush(state, segmentKey)`.

The reference shape for a channel-owning segment is `segments/plastron-dom/src/index.ts`. The reference shape for a plastron-first app is `examples/plastron-spa-demo/src/main.ts`.

## Repo conventions

- **Boot sequence (apps):** `createInitialState()` → `installX(state, …)` for side-effect segments → `hydrate(state, [yourSegment])` → `runCycle(state)` → **`precomputeOptional(state)`** → `installDom` (or other channel) → `runCycle(state)` → `handle.channel.drain()`. Deviations should be deliberate; the older simpler examples are usually right.
- **Segment install convention:** `installX(state, options?)` is the only side-effect entry point. Module imports must not mutate state. Per-state caches use `WeakMap<State, …>`.
- **Channels register before cels reference them.** Late registrations are silently dropped from cel routing.
- **Teardown via sentinel cel.** Any segment that owns a channel or listener installs a sentinel cel with `_dispose`. `flush(state, segmentKey)` triggers cleanup.
- **Manifest's `provides` must be honest.** Used by `findDependents` and `flush`. Lie about it and teardown leaks.
- **Cel keys in formulas:** ASCII `[\w.-]+`. Unicode is fine in `inputMap` values.
- **Plastromancy / 甲 file naming:** the on-disk format is `.甲`. The term is **plastromancy** (not "plastronomy"). The user has corrected this before.

## Sibling repos

- `~/projects/xit-wasm-ts` — the content-addressed wasm store that plastron-archive sits on top of. Uncommitted patches on `xit-wasm-ts/main` make the browser path work: removed the top-level `import * as fs from "node:fs/promises"` and replaced it with a runtime-built dynamic specifier (`/* @vite-ignore */`) so Vite doesn't try to bundle `node:fs/promises` into browser builds. Until those patches land, plastron-cms's browser build needs the local checkout.

## What this repo is NOT

- A general-purpose state library to replace Redux. The point is the reactive graph + on-disk format, not the get/set shape.
- A CRDT. No real-time multi-user collab story.
- A framework. The kernel is small; segments are independent; hosts choose what to mount.

## When the user asks for "an app"

Start by asking: which cels? Don't open `package.json`, don't scaffold a React tree, don't pick a UI framework. Decide cels + segments + hydration source FIRST. Then pick the host. The plastron-first design check is in `DESIGN.md`.

If you're unsure whether something is plastron-first enough, run it past the **Review rubric — apps** checklist in `DESIGN.md`.
