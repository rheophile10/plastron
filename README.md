# plastron 🐢

Plastron is a polyglot reactive substrate. Cels hold values, formulas, or compiled lambdas; writing to one fires a cascade that recomputes everything downstream in topological order. The cel graph is the substrate — questions, data, computation, and answers all live on the same artifact, and the whole thing round-trips through JSON.

The eventual shape is a **polyglot spreadsheet**: you write functions in cels using any language a compiler has been installed for (JS, WAT, Python, Scheme, …), then call those functions from formulas in other cels. Formulas read state, write back through channels — the DOM, HTTP, a database. The same kernel powers a spreadsheet UI, a CLI utility, or a web app. The ideal deployment is a single `index.html` you can open, edit, share, and archive.

## What it's for

- **Web apps.** Cels back the state; formulas compute derived values; a DOM channel paints the result. Inputs flow in from the host, changes flow out through channels.
- **CLI utilities.** The kernel runs anywhere TypeScript runs. No browser required — mount cels under a script, write derived values, exit.
- **Polyglot spreadsheets.** The end goal. A spreadsheet where any cell can be a function in any installed language, and any other cell can call it from its formula.

Three properties that fall out of the design:

- **The formula language is yours.** The kernel only knows cels, dependencies, and a tiny set of arithmetic builtins. Everything else — formula parsers, JS lambdas, WASM-backed languages — installs as a *compiler cel*. Add a kind and cels can speak it.
- **The graph is data.** Cels, schemas, and compilers all dehydrate to JSON segments you can serialize, ship, diff, archive. The ideal artifact is a single `index.html` carrying the whole graph inline.
- **The host is interchangeable.** A cascade is just `runCycle(state)`. React, the DOM, a CLI, a worker — the kernel doesn't care.

## Lore

The name comes from the Shang-dynasty diviners who heat-cracked turtle plastrons to compute answers and inscribed both the question and the answer on the same shell. One artifact: substrate, query, computation, record. Spreadsheets are the same idea, three thousand years later. See [`plastromancy.md`](plastromancy.md).

## Repo layout

```
plastron-simple/         — the current kernel
plastron-simple-examples/
  pictograph/            — first end-to-end app on the current kernel
plastron/                — the original kernel (being replaced)
segments/                — the original segment ecosystem (being replaced)
examples/                — apps on the original kernel (being replaced)
bench/                   — perf benches + krausest framework comparison
notes/                   — design notes and lessons
```

## Status of the rewrite

**`plastron-simple/` is replacing `plastron/`.** This is not a refactor of the old kernel — it's a from-scratch rewrite with a smaller surface, async-aware compile, and first-class support for creating and editing function bodies inside cels (both `new Function` JS and WASM). The cel registry *is* the dispatch surface — there's no parallel `state.fns` map; compilers are themselves cels.

As `plastron-simple` gains capability, the original `plastron/`, the segments under `segments/`, and the apps under `examples/` will be deleted, not maintained. They're kept for now only as a reference for behaviors the new kernel has yet to reach. The bar to port a segment is: *does the simplified kernel let us write it with less ceremony than the old one?* If not, we keep simplifying the kernel first instead of forcing a port.

A short history:

1. **First kernel + segments + examples.** Wide segment ecosystem (DOM, archive, sheet, canvas, chart, multiplane, PDF, xlsx, IndexedDB, Postgres, SQLite, …). It works, but the surface grew faster than the design rules and the boundary between "kernel feature" and "convention" got blurry.
2. **Benches.** `bench/` measures plastron against React (per-cell, react-memo) and against the krausest js-framework-benchmark for DOM rendering. The headline lesson — cels mark reactivity boundaries; don't put one where you don't want reactivity — is captured in `bench/RESULTS.md` and is what drives the simplification phase.
3. **Tests.** A test suite went in around the first kernel to lock down cascade, hydration, and segment lifecycle behavior. `plastron-simple/test/` inherits the same discipline.
4. **Pictograph.** A small end-to-end app (`plastron-simple-examples/pictograph/`) exercising function-source persistence and round-trip on the simplified kernel. Building it surfaced what the kernel still made awkward — chiefly, how cels create and edit their own lambda bodies.
5. **Kernel simplification (now).** `plastron-simple/` is the from-scratch rewrite. It currently runs **four languages in one DAG** — see "Pictograph today" below.

## Pictograph today

`plastron-simple-examples/pictograph/` is the integration testbed for the simplified kernel. It demonstrates four execution domains in one reactive graph:

| Domain   | Compiler kind | How                                                |
|----------|---------------|----------------------------------------------------|
| JS       | `js`          | `new Function` (CSP-gated)                         |
| WAT      | `wat`         | wabt.js → wasm bytes → `WebAssembly.instantiate`   |
| Python   | `py`          | Pyodide (main-thread or `worker_threads`-isolated) |
| JS-in-wasm | `quickjs`   | QuickJS-emscripten (interpreter as wasm)           |

The DAG, conceptually:

```
JS:     pair = [3, 4] ── (applyFn pair) ── result
                                          ↑
                                       (swap applyFn at runtime;
                                        cascade re-fires)

WAT:    a, b ── wat-add ── wat-result ── (wat-to-js wat-result) ── wat-result-js
                kind:"wat", outputSchema:"wasm:i32"   ↑
                                                  explicit bridge cel

Python → QuickJS, via explicit bridges:
        left, right ── py-greet ── py-greeting (py-domain)
                                       │
                                       ↓
                              (py-to-js py-greeting) ── py-greeting-js   (js-domain)
                                       │
                                       ↓
                              (js-to-quickjs py-greeting-js) ── py-greeting-qjs   (quickjs-domain)
                                       │
                                       ↓
                              (qjs-shout py-greeting-qjs) ── qjs-shouted = "HELLO, WORLD!!!!"

Python composite handle (stays in py-domain):
        py-make-pair ── pair-handle   (WasmHandle, NOT marshalled)
        outputSchema:"wasm:opaque"        │
                                          ↓
                                    (py-join-pair pair-handle) ── joined = "👦👋👧"
                                    handle dereferenced INSIDE Python; dict
                                    never crosses the kind boundary
```

Properties this exercises:

- **Cels carry an execution kind.** `kindOf(cel)` returns `"js"`, `"wat"`, `"py"`, `"quickjs"`. Per-kind precompute layers (`waveCascadeByKind`) group cels by kind within each wave so future per-kind dispatch (e.g., worker postMessage batches) plugs in without further kernel changes.
- **Bridge cels are first-class.** `(wat-to-js x)`, `(py-to-js x)`, `(js-to-quickjs x)`, etc. are real DAG nodes. The kernel refuses to silently auto-bridge across mismatched kinds (opt-in via `metadata.inputKinds`); explicit bridges are where marshalling cost lives.
- **Composite WIT handles.** When a py cel declares `outputSchema: "wasm:opaque"` (or any composite WIT type), the wrapper returns a `WasmHandle` pointing into the kind's value table rather than eagerly marshalling. Downstream cels of the same kind dereference server-side; the bridge cel materializes only when the value needs to leave the domain.
- **Worker isolation.** `py.worker-mode = true` spawns a Node `worker_threads` worker hosting Pyodide. Calls become postMessage round-trips; `py.ready` transitions false → true at boot; Python exceptions transport as `CelError`s. Same model will work for browser `Worker` after the [Bun migration](#).
- **Hot-reload + compile cache.** Source-hash-keyed cache (per kind). Edit a `cel.f`, the next compile is a cache hit if you revert. Editor flows get instant feedback.
- **Trap-as-value error model.** A Python exception, WAT trap, or syntax error becomes a tagged `CelError` on the failing cel's `v`; the cascade survives; downstream cels see the error and propagate. A central state-level `errors` log accumulates everything for diagnostics.

Run it: `cd plastron-simple-examples/pictograph && npm start`.

## Roadmap

The next milestones, in order:

1. **Bun migration.** Convert CLI runtime from Node+tsx to Bun so the worker spawn path uses the WHATWG `Worker` API — the same code that runs in browsers. Today's Pyodide-in-worker demo uses `node:worker_threads` and would need separate code for the browser. Bun collapses that.
2. **Browser-deployable build.** `bun build --target=browser` bundles the kernel + dependencies + pictograph segment into a single `index.html`-ready artifact. The eventual product shape.
3. **plastron-dom segment, simplified.** Minimal DOM channel + vnode schema rebuilt against the new kernel. The replacement for the legacy `segments/plastron-dom/`.
4. **plastron-sheet, simplified.** Excel-style spreadsheet UI on top of (1) + (2) + (3). Same shape as `examples/plastron-sheet/`, rebuilt cel-first. **This is the headline app.**

After that, the rest of the old segment ecosystem (archive, fetch, chart, canvas, IndexedDB, …) gets rewritten on top of the simplified kernel as use cases demand, and the corresponding directories under `plastron/`, `segments/`, and `examples/` are deleted.

## Status

v0.0.0. Two kernels currently live in the tree, but only one of them has a future. APIs in both are unstable; expect breakage. Doc claims about specific APIs or perf numbers may be stale relative to source — check `bench/RESULTS.md` and recent `git log` before relying on a specific claim.

## License

[MIT](LICENSE).
