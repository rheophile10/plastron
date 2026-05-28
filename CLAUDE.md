# CLAUDE.md — plastron repo

This monorepo is in transition. **`plastron-simple/` is the live kernel.** The original `plastron/`, the segment ecosystem under `segments/`, and the apps under `examples/` are deprecated and will be deleted as plastron-simple absorbs their use cases.

The eventual product is a polyglot reactive substrate that can be a web app, a CLI utility, or a spreadsheet — all deployable as a single `index.html`. See `README.md` for the full pitch and roadmap.

## Default to plastron-simple

When asked to build, fix, or extend something in this repo, work in `plastron-simple/` (and `plastron-simple-examples/`) unless the user explicitly names one of the deprecated directories. Don't refactor or "improve" code under `plastron/`, `segments/`, or `examples/` — it's going to be deleted. If a deprecated file is the only thing that does what you need, surface that to the user instead of porting fixes back into doomed code.

## Cels mark reactivity boundaries

Plastron-first ≠ everything-is-a-cel. Make something a cel only when reactivity buys you something: independent observation, channel binding, partial invalidation, per-slot persistence. Inner compute — loop accumulators, scratch values, things only read in aggregate — stays inside a native fn. Measured: collapsing N intermediate cels into one native-fn cel beats both per-cel plastron AND react-memo (`bench/RESULTS.md`).

The benches were run against the original kernel; the design lesson (cel granularity) carries over to plastron-simple unchanged.

## API anchors (plastron-simple)

Public surface from `plastron-simple/src/index.ts`:

```ts
import { createInitialState, precompute, precomputeOptional, resolveFn } from "plastron";
const state = createInitialState();
const hydrate  = resolveFn(state, "hydrate")  as Fn;   // async
const runCycle = resolveFn(state, "runCycle") as Fn;
const set      = resolveFn(state, "set")      as Fn;
const batch    = resolveFn(state, "batch")    as Fn;
const setCel   = resolveFn(state, "setCel")   as Fn;
const register = resolveFn(state, "registerLambda") as Fn;
```

Notes:

- **The cel registry is the dispatch surface.** Every fn — including core ones — lives as a cel in `state.cels`; `resolveFn(state, key)` returns `cel._fn`. There's no `state.fns` map.
- **`hydrate` is async.** Compilers may return `Promise<CompiledLambda>` so they can lazy-load runtimes (Javy, wabt.js, Pyodide). Within each topo layer, `compileFireable` parallelizes via `Promise.all`. See `plastron-simple/docs/ASYNC-COMPILE.md`.
- **Compilers are cels.** Register one with `registerLambda({ key: "myKind", fn: (source) => ..., kind: "custom" })`, then any `EditableLambdaCel` with `metadata.kind: "myKind"` will use it.
- **Formula syntax is S-expression.** `(* price qty)`, `(+ a b c)`. The default parser is at key `"f"`; arithmetic builtins (`+ - * /`) live in the `builtins` segment.

## Documentation flow — how docs and code move together

`plastron-simple/docs/` is organized as a development pipeline. Every doc has a place; placement encodes status. Before writing or moving docs, **read the meta-docs in `plastron-simple/docs/4-current/documentation/`** — they define the conventions for each stage:

- `design-folder-design.md` — how `1-design/` is organized (proposed ideas under `1-under-consideration/`, evolving under `2-in-evaluation/`, committed under `3-accepted/`; rejection is in-place via `status: rejected` — there is no `4-rejected/` folder). Only `3-accepted/` uses area subfolders matching `4-current/`'s NN-name pattern (plus a `documentation/` subfolder for meta-docs); `1-under-consideration/` and `2-in-evaluation/` are flat, with the design's area in frontmatter.
- `roadmap-design.md` — how `2-roadmap/` is organized (critical-path numbered `.md`s + `parallel/` + `completed/`; YAML frontmatter on every task).
- `test-design-folder-design.md` — how `3-test-design/` is organized.
- `current-features-design.md` — how `4-current/` is organized (one NN-name folder per lifecycle stage; numbered `.md`s within each).

The pipeline:

```
1-design/         — ideas; flow through 1-under-consideration → 2-in-evaluation → 3-accepted (rejection is in-place, no 4-rejected/)
2-roadmap/        — committed work, ordered by critical path
3-test-design/    — test specs derived from accepted designs
4-current/        — what shipped + is tested
```

A feature moves: idea (`1-design/1-under-consideration/` — flat) → vetted (`1-design/2-in-evaluation/` — flat) → committed (`1-design/3-accepted/<area>/` + roadmap entry in `2-roadmap/`) → tested (`3-test-design/<area>/`) → shipped (`4-current/<area>/`). The `<area>` path component is added on acceptance; before that the area lives in frontmatter. Rejected ideas stay in place with `status: rejected`.

**Agents contributing docs follow these conventions.** New design doc → land flat in `1-design/1-under-consideration/`. Promoting an idea → move into the next state folder + update frontmatter (acceptance adds the `<area>/` subfolder). Shipping a feature → write the `4-current/<area>/` doc, anchored in passing tests. If you're unsure which stage a doc belongs in, read the relevant meta-doc in `4-current/documentation/` first.

## These docs are point-in-time

This file and the README are synthesized from a snapshot. Before relying on a specific claim (an API shape, a perf number, a file path), do a fast sanity-check against the current source. **If you find a contradiction, flag it to the user before acting** — don't silently follow either the doc or the new note.

Sources of truth:

- `plastron-simple/src/` — the kernel itself.
- `plastron-simple/docs/4-current/` — what's actually shipped, organized by lifecycle stage (boot → hydration → caching → precompute → runCycle → mutations → wasm → dehydration → storage). Anchored in tests.
- `plastron-simple/docs/2-roadmap/` — committed in-flight work.
- `plastron-simple/docs/1-design/3-accepted/` — designs accepted but not yet shipped.
- `plastron-simple/docs/1-design/{1-under-consideration,2-in-evaluation}/` — ideas in motion; treat as proposals, not contracts.
- `plastron-simple/test/` — executable contract for the kernel surface.
- `bench/RESULTS.md` — bench numbers (measured on the original kernel; design lessons still apply).
- `git log` on `plastron-simple/src/` — recent moves.

## Repo conventions

- **Naming.** The on-disk archive format is `.甲`. The lore term is **plastromancy** (the practice) — not "plastronomy". The user has corrected this before.
- **Cel keys in formulas:** ASCII `[\w.-]+`. Unicode is fine elsewhere.
- **Code that touches deprecated directories** (`plastron/`, `segments/`, `examples/`) requires explicit user opt-in. If asked to fix something there, double-check the user actually wants the fix rather than a port forward to plastron-simple.
- **Prefer Bun built-ins when they're available in both CLI and browser.** `bun:sqlite` (with `sqlite-wasm + OPFS` as the browser twin), `Bun.password`, `Bun.hash`, `WebSocket`, `fetch`, `Worker`, `HTMLRewriter`, etc. — reach for them before pulling npm packages or rolling our own. See `plastron-simple/docs/BUN-FEATURES.md` for the full survey and which APIs cross both runtimes.

## When the user asks for "an app"

Start by asking: which cels? Decide cels + compilers + hydration source FIRST. Then pick the host. The ideal deployment shape is a single `index.html`; aim for that unless the user says otherwise.

## What this repo is NOT

- A general-purpose state library to replace Redux. The point is the reactive graph + on-disk format.
- A CRDT. No real-time multi-user collab story.
- A framework. The kernel is small; hosts choose what to mount.
