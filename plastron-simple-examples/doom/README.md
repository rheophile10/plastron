# plastron-simple-examples/doom

Minimal "initialize doom" demo — a single page that loads `doom.wasm`
through plastron's `kind:"wasm"` loader, captures the live instance via
the `wasm-host-instance` provider hook, runs `_initialize`, and displays
the captured exports.

Proves three things, in order:

1. The offline-built `.wasm` artifact loads through plastron's loader
   (`kind:"wasm"`, base64 source).
2. The `wasm-host-instance` hook hands the host the live instance —
   multiple exports + linear memory, reachable via
   `instance.exports.*`.
3. Reactor-mode `_initialize` runs to completion against stub WASI +
   `env` imports.

This is **not Doom playing yet** — there's no canvas, no RAF loop, no
WAD. That's `doom-harness`, the next roadmap step. This page is the
walking skeleton, made interactive so you can click a button and see
the artifact load.

## Prereqs

### 1. The compiled artifact (`doom.wasm`)

Not in this folder yet (the factory lives outside this repo). Build it:

```bash
bash ~/projects/wasm-factory/doom/build.sh
cp ~/projects/wasm-factory/dist/doom.wasm \
   ~/projects/plastron/plastron-simple-examples/doom/doom.wasm
```

First factory run: ~2–5 minutes (downloads wasi-sdk, clones doomgeneric).

### 2. A WAD (optional but recommended — freedoom auto-loads)

The page auto-loads `freedoom1.wad` from the example root if present, so
you don't have to pick one each visit. Set it up once:

```bash
# Download freedoom (free, Doom-compatible IWAD; ~30 MB)
mkdir -p ~/test-wads && cd ~/test-wads
curl -fsSLO https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip
unzip freedoom-0.13.0.zip && rm freedoom-0.13.0.zip
# Symlink into the example dir (gitignored)
cd ~/projects/plastron/plastron-simple-examples/doom
ln -s ~/test-wads/freedoom-0.13.0/freedoom1.wad ./freedoom1.wad
```

Without the symlink, the file picker on the page still works for any
WAD you have locally (`doom1.wad` shareware, your own copies, etc.).

## Run the page

```bash
cd ~/projects/plastron/plastron-simple-examples/doom
bun run dev
# → http://localhost:3000
```

`bun run dev` does two things:

- `bun build index.html --target=browser --outdir dist …` — bundles
  `main.ts` + plastron-simple into `dist/`.
- `bun serve.ts` — serves `dist/` on `:3000`, with `doom.wasm` routed
  from the example root.

Click **Initialize doom.wasm**. You should see the doom.wasm size, the
captured memory size, and a list of exports including
`doomgeneric_Create`, `doomgeneric_Tick`, `memory`, and `_initialize`.

If `doom.wasm` isn't there, the page tells you the exact commands to
get it.

## What the code does

`main.ts` is ~110 lines:

1. Fetches `./doom.wasm`, base64-encodes it.
2. Registers a stub-imports provider that returns
   `{ imports, onInstantiate }`. `imports` is two `Proxy`'d namespaces
   (`env`, `wasi_snapshot_preview1`) where every name resolves to a
   `() => 0` no-op — WASI errno SUCCESS. `onInstantiate` captures the
   live `WebAssembly.Instance` into a closure.
3. Hydrates a `kind:"wasm"` `EditableLambdaCel` whose
   `metadata.imports` points at the provider. The declarative hydrate
   path threads `metadata.imports` through `CompileContext`, so the
   wasm compiler invokes the provider and honors the envelope.
4. Calls `captured.exports._initialize()` — directly, from JS, against
   the captured instance.
5. Renders the result.

The provider is the only plumbing — plastron's `kind:"wasm"` +
`wasm-host-instance` does the rest.

## Tests

```bash
bun run test
# init.test.ts          (4) — artifact shape, plastron load path
# harness.test.ts       (3) — WASI shim against empty WAD: traces I_Error
# harness-real-wad.test (5) — real WAD against the harness (needs WAD; see below)
# → 12 pass on a fresh checkout with the freedoom WAD installed
```

### Real-WAD tests (skipped without a WAD)

`harness-real-wad.test.ts` runs the harness against an actual freedoom
IWAD. The tests **skip** if no WAD is found. To enable:

```bash
mkdir -p ~/test-wads && cd ~/test-wads
curl -fsSLO https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip
unzip freedoom-0.13.0.zip && rm freedoom-0.13.0.zip
# tests look for ~/test-wads/freedoom-0.13.0/freedoom1.wad by default,
# overridable via FREEDOOM_WAD=/path/to/your.wad
```

Or point at any other WAD (`DOOM1.WAD` shareware, `doom2.wad`, etc.) via
`FREEDOOM_WAD=/path/to.wad bun run test`.

## Known engine bug

`doomgeneric_Tick` (and sometimes `doomgeneric_Create`, depending on
build flags) traps with `call_indirect to a signature that does not
match`. This is a doomgeneric+wasm-CFI incompatibility (the engine's
`actionf_t` union holds function pointers with mismatched signatures
that x86 tolerates but wasm rejects). The harness's WASI shim is
provably correct — doom reaches every boot milestone before tripping
the trap. See the `[known issue]` characterization test in
`harness-real-wad.test.ts` and the
"Known engine bug" section of the doom-harness design doc for the
fix-it options.

## Anchors

- `kind:"wasm"` loader:
  `../../plastron-simple/docs/4-current/07-wasm/11-wasm-bytes-kind.md`
- Host-instance hook:
  `../../plastron-simple/docs/4-current/07-wasm/12-wasm-host-instance.md`
- Roadmap: `../../plastron-simple/docs/2-roadmap/parallel/doom-wasm-build.md`
- Factory (the build that produced `doom.wasm`):
  `~/projects/wasm-factory/`
