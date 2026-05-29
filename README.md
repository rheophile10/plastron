# plastron 🐢

Plastron is a polyglot reactive substrate. Cels hold values, formulas, or compiled lambdas; writing to one fires a cascade that recomputes everything downstream in topological order. The cel graph **is** the substrate — questions, data, computation, and answers all live on the same artifact, and the whole thing round-trips through JSON.

The eventual shape is a **polyglot spreadsheet**: you write functions in cels using any language a compiler has been installed for (JS, WAT, Python, Scheme, …), then call those functions from formulas in other cels. The same kernel powers a desktop shell, a spreadsheet UI, a CLI utility, or a web app. The ideal deployment is a single `index.html` you can open, edit, share, and archive.

## Try it now

**[https://rheophile10.github.io/plastron/](https://rheophile10.github.io/plastron/)** — the bundled OS shell. One static page, ~200 KB, no server. OPFS-backed user-spaces persist in the browser; everything you save in Notepad, Sheets, or Doom stays in your browser's storage. Click 📊 Sheets, 📝 Notepad, 🗂 Files, or 🎮 Doom.

## What's there

**plastron-OS** — a desktop shell that boots to a home screen of app icons, launches an app on click, and exits back home. Four apps run on it today, all sharing the same kernel:

- **Sheets** — per-cell view cels, formula bar, infix `=A1*B1` formulas, click-to-edit, persistence as a user-space segment.
- **Notepad** — textarea bound to a single cel; New / Save / Open via the shared file toolbar.
- **File Explorer** — folders + drag-and-drop. Folder layout + per-file location is persisted as `fs-tree`, a special user-space segment. Auto-files new docs into `/<app>`.
- **Doom** — Freedoom 1 running on the actual [doomgeneric](https://github.com/ozkl/doomgeneric) engine compiled to wasm. The 28 MB WAD + 1 MB wasm binary are inlined gzip+base64 into the bundle and decoded once into OPFS. Mouse, keyboard, 60 fps.

A shared **file picker modal** opens from Notepad / Sheets when you click 📂 Open — same folder tree as File Explorer, scoped to the requesting app. Click backdrop or × to dismiss.

Apps and the OS itself are **plastron segments** — JSON-shaped collections of cels that hydrate into a running state. The shell, the file toolbar, the doc-binding glue, the file picker, the file explorer, even the spreadsheet engine, are all segments.

## What it's for

- **Web apps.** Cels hold state; formulas compute; the DOM channel paints. Inputs flow in from the host, changes flow out through channels.
- **Polyglot spreadsheets.** The headline. Any cell can be a function in any installed language; any other cell can call it via a formula.
- **Self-contained software.** The whole graph — code, data, schemas, compilers — round-trips through JSON. One `.zip` (or one `index.html`) carries the app, the user's data, and enough info to recreate them anywhere.
- **CLI utilities.** The kernel runs anywhere TypeScript runs. Same code in browser and `bun` CLI.

Three properties fall out of the design:

- **The formula language is yours.** The kernel only knows cels, dependencies, and arithmetic builtins. Everything else — formula parsers, JS lambdas, WASM-backed languages — installs as a *compiler cel*. Add a `kind`, cels can speak it.
- **The graph is data.** Cels, schemas, compilers, even the host runtime all dehydrate to JSON segments. Ship a `.zip`, fold it into an `index.html`, or just commit it to git.
- **The host is interchangeable.** A cascade is just `runCycle(state)`. React, the DOM, a CLI, a worker, a github-pages static deploy — the kernel doesn't care.

## Lore

The name comes from the Shang-dynasty diviners who heat-cracked turtle plastrons to compute answers and then inscribed both the question and the answer on the same shell. One artifact: substrate, query, computation, record. Spreadsheets are the same idea, three thousand years later. The on-disk archive format is `.甲`. The practice is **plastromancy**.

## Repo layout

```
plastron-simple/                         the live kernel (rewrite)
  src/                                     small surface; cel registry is the dispatch surface
  test/                                    discipline lock-in
  docs/                                    pipeline: 1-design → 2-roadmap → 3-test-design → 4-current
                                           (gitignored; live, evolves between sessions)

plastron-simple-examples/
  plastron-os/                           the OS shell + 4 apps, deployed at github pages
    browser-main.ts                        boot entry — sets up segments, mounts the painter
    desktop.ts                             home screen + icon launcher
    sheets.ts                              spreadsheet (per-cell view cels + formula bar)
    file-explorer.ts                       folders + drag-and-drop + fs-tree persistence
    file-picker.ts                         shared Open modal (Notepad + Sheets)
    file-toolbar.ts                        New / Save / Open buttons across apps
    doc-binding.ts                         retargets editor cels into the active user-space
    bundle.ts                              single index.html builder (inlines doom assets)
    serve.ts                               local dev server (bun)
    e2e/                                   Playwright + system Chrome
  doom/                                  reusable wasm harness for doomgeneric
  pictograph/                            4-language polyglot DAG smoke (js / wat / py / quickjs)
  sheets/  notepad/  file-explorer/  …   sibling sandbox examples developed in parallel

bench/                                   perf benches + the krausest framework comparison
plastromancy.md                          lore + design philosophy long-form

plastron/  segments/  examples/          original kernel + ecosystem — being phased out
                                         (do NOT add to; see CLAUDE.md for policy)
```

## Develop

Bun and a system Chrome are the only hard requirements.

```bash
# Inside plastron-simple/ — build the kernel (tsc → dist/)
cd plastron-simple
bun install
bun run build         # produces dist/ that everything else imports
bun test              # the kernel test suite

# Inside plastron-simple-examples/plastron-os/ — build + run the OS
cd ../plastron-simple-examples/plastron-os
bun bundle.ts         # → dist/index.html, one file, ~200 KB (plus inlined doom ~13 MB)
bun serve.ts          # http://localhost:5173 with the headers OPFS needs
bun run test          # unit tests (fake DOM, bun:test)
bun e2e/run.ts        # Playwright via system google-chrome (no npm browser download)
```

`dist/` is gitignored; deploying via GitHub Pages happens through `.github/workflows/pages.yml` which rebuilds + redeploys on every push to `master`. The live site at https://rheophile10.github.io/plastron/ is the bundled output.

## How the OS is built

```
kernel (plastron-simple/)
  cels + cascade + segments + compilers (formula, js, html-template, infix, …)
  hydrate / dehydrate / round-trip via JSON
  channel registry (plastron-dom.paint, …)

  ↑

application segments (plastron-simple-examples/plastron-os/)
  desktop  ← icon grid + per-view mount gating
  sheets   ← per-cell view cels + formula bar + metadata panel
  notepad  ← textarea ↔ notepad.text
  file-explorer  ← folder tree + drag-and-drop + fs-tree user-space
  file-picker (library)  ← shared Open modal
  file-toolbar (library) ← New / Save / Open buttons
  doc-binding (library)  ← editor cels round-trip through user-space segments
  doom     ← canvas + on-demand wasm boot via doomgeneric

  ↑

user-space segments (created at runtime, persisted in OPFS via segment-store)
  notepad-untitled-1, sheets-untitled-2, fs-tree, …
  each holds its own data cels; dehydrate ↔ JSON .甲 archive
```

The boot entry (`browser-main.ts::bootOS`) wires it all together: create kernel state → setup each segment → precompute → mount the painter → paint the home screen.

## What's next

The rewrite phase is done; what remains is breadth, performance, and depth in specific apps:

- **Per-cell render at 50×50 in one RAF frame.** Sheets v1.1 ships per-cell view cels (Option A from `1-design/sheet-keyed-render.md`). The remaining work is measuring + tightening hydrate and cascade walk under 2 500-cel load.
- **In-page user-space picker for save/save-as.** The shared file picker handles Open today; the New / Save path still uses `window.prompt` for the doc name. A "Save As" mode of the same modal closes the loop.
- **Real HTML5 drag from File Explorer's tree.** Drag-drop is wired via the kernel's `dragstart` / `drop` events; the e2e tests exercise the dispatch helpers directly. Real-mouse drag in the live UI works via the actual events but isn't yet asserted in e2e (Playwright's `page.dragAndDrop` uses mouse events, not the HTML5 drag protocol).
- **CRDT or last-write-wins multi-doc sync.** Not in scope today — OPFS is per-browser.
- **More compiler kinds in the OS shell.** Pictograph has js / wat / py / quickjs; the OS only uses the formula + html-template + infix compilers so far.
- **The rest of the old ecosystem.** archive, fetch, chart, canvas, IndexedDB, … get rewritten on top of the simplified kernel as use cases demand. The corresponding directories under `plastron/`, `segments/`, `examples/` get deleted as they're replaced.

## Status

v0.0.0. The live deploy works and the kernel + OS shell are stable enough to develop apps on; APIs are still moving (no semver yet, expect breakage). The doc tree under `plastron-simple/docs/` is the pipeline of designs, roadmap items, test specs, and shipped features — anchored in passing tests. Recent kernel/repo changes go in `git log`; perf numbers in `bench/RESULTS.md`.

## License

[MIT](LICENSE).
