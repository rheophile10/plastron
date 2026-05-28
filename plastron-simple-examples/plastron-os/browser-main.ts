// ============================================================================
// plastron-OS — boot entry for the single-file index.html.
//
// Boots the kernel, sets up the desktop (home screen + launcher) and the
// apps, mounts the painter on #app, and paints the home screen. Clicking an
// icon launches an app (os.switch via app-host); each app's view is gated on
// os.active and paints over #app; the red × in its upper-right corner
// calls os.exit to close the app back to the home screen.
//
// Apps wired here: Sheets (v1.1 — per-cell view cels + shared file toolbar +
// metadata panel), Notepad (with the shared toolbar), File Explorer (lists
// user-spaces from segment-store; click-to-open), and a Doom placeholder
// (the wasm harness slot).
// ============================================================================

import {
  createInitialState, precompute, precomputeOptional, resolveFn, createPainter, setPainter, getPainter,
} from "../../plastron-simple/dist/index.js";
import { setupDesktop } from "./desktop.js";
import { buildSheetsApp } from "./sheets.js";
import { setupFileToolbar } from "./file-toolbar.js";
import { setupFileExplorer } from "./file-explorer.js";
import { setupFilePicker } from "./file-picker.js";
import { registerDocBinding } from "./doc-binding.js";
// Generated at build time by bundle.ts. Constants are empty strings when the
// source files are absent at build time — runtime then falls back to fetch.
import { DOOM_WASM_GZ_B64, DOOM_WAD_GZ_B64 } from "./doom-assets-inline.js";

// State + helpers are scoped inside bootOS() so tests can boot a fresh OS
// against a per-test globalThis.document (Bun caches modules; a top-level
// `const state = createInitialState()` would be shared across tests).

export const bootOS = async (): Promise<{ state: ReturnType<typeof createInitialState> }> => {
const state = createInitialState();
const r = (k: string) => resolveFn(state, k) as (...a: unknown[]) => unknown;

// ── Notepad: a small custom view sharing the file toolbar ──────────────────
// (We bypass buildNotepad's view to fit the per-view mount-gating + shared
// toolbar pattern; its data layer is small enough to re-author here.)
const setupNotepad = async (): Promise<void> => {
  await r("registerLambda")(state, {
    key: "notepad.input", kind: "custom",
    fn: async (st: unknown, _p: unknown, event: { target?: { value?: string } }) => {
      await (resolveFn(st as never, "set") as (...a: unknown[]) => unknown)(st, "notepad.text", event?.target?.value ?? "");
    },
  });
  const seg = {
    name: "notepad", version: "0.1.0",
    dependencies: ["app-host", "html-template-parser", "plastron-dom", "segment-store", "user-space-ops"],
    role: "application",
    cels: [
      { key: "notepad.text", celType: "ValueCel", metadata: { key: "notepad.text", segment: "notepad" }, v: "" },
      { key: "notepad.mount", celType: "FormulaCel", metadata: { key: "notepad.mount", segment: "notepad", parser: "f", inputMap: { active: "os.active" } }, f: `(if (eq active "notepad") "#app" null)` },
      {
        key: "notepad.view", celType: "FormulaCel",
        metadata: { key: "notepad.view", segment: "notepad", parser: "html-template", schema: "render-spec", channel: ["plastron-dom.paint"], inputMap: { mount: "notepad.mount", text: "notepad.text", doc: "os.doc" } },
        f: `<div class="np">{{(renderFileToolbar doc)}}<div class="toolbar"><button class="close" onClick={{(dispatch "os.exit")}}>×</button><span>Notepad</span></div><textarea class="pad" value={{text}} onInput={{(dispatch "notepad.input")}}></textarea></div>`,
      },
    ],
  };
  await r("hydrate")(state, [seg], [{ name: seg.name, version: seg.version, dependencies: seg.dependencies, role: "application" }]);
  // Doc binding: file.new / file.save / file.open retarget notepad.text into
  // the active user-space so its content round-trips through segment-store.
  registerDocBinding({ app: "notepad", cels: ["notepad.text"], empty: () => "" });
};

// ── Doom asset loader — OPFS-seed-once, then embedded gz blob, then fetch ──
// On a served-over-http page (OPFS available, secure origin), the FIRST boot
// decodes the inlined gzip blob and writes it to OPFS at `opfsPath`; every
// subsequent boot reads OPFS directly and skips the decode entirely. On a
// double-clicked file:// page (OPFS throws SecurityError on the opaque null
// origin) the OPFS branch is silently skipped and we just decode each boot.
// `fetchUrl` is the dev-server fallback for when the bundle didn't inline
// the asset (gzB64 is empty). Returns null only if ALL sources fail.

// ── Doom — real wasm harness, auto-boots when activated ──────────────────────
// On app activation (os.active → "doom"), `doom.maybe-boot` (a side-effect
// fn driven by a FormulaCel watching os.active) fires doom.boot after a
// RAF so the canvas exists in the DOM. doom.boot uses the inlined
// doom.wasm bytes (via bundle.ts's pre-pass) — no separate file to
// deploy. WAD: tries fetch("./freedoom1.wad") first; on 404 surfaces a
// file picker so the user can upload one (github-pages friendly).
// doom.boot is idempotent — already-booted → no-op.
const setupDoom = async (): Promise<void> => {
  type DoomHarnessModule = typeof import("../doom/doom-harness.js");
  let doomHarness: Awaited<ReturnType<DoomHarnessModule["createDoomHarness"]>> | null = null;
  let booting = false;

  const setStatus = async (msg: string): Promise<void> => {
    await (r("set") as (...a: unknown[]) => Promise<unknown>)(state, "doom.status", msg);
  };
  const setNeedsWad = async (needs: boolean): Promise<void> => {
    await (r("set") as (...a: unknown[]) => Promise<unknown>)(state, "doom.needs-wad", needs);
  };

  // OPFS-first asset loader (see doc block above setupDoom). One source-order
  // chain shared by doom.wasm + freedoom1.wad: cache hit → embedded gz blob
  // → fetch fallback → OPFS write-back for next boot.
  interface LoadDoomAssetArgs {
    opfsPath: string; gzB64: string; fetchUrl: string; label: string;
  }
  const loadDoomAsset = async (args: LoadDoomAssetArgs): Promise<Uint8Array | null> => {
    const { opfsPath, gzB64, fetchUrl, label } = args;
    const fsExists = r("fs.exists") as ((p: string) => Promise<boolean>) | undefined;
    const fsRead   = r("fs.read")   as ((p: string) => Promise<Uint8Array>) | undefined;
    const fsWrite  = r("fs.write")  as ((p: string, b: Uint8Array) => Promise<unknown>) | undefined;
    const backend  = state.cels.get("file-store.backend")?.v;
    if (fsExists && fsRead) {
      try {
        if (await fsExists(opfsPath)) {
          await setStatus(`loading ${label} from OPFS…`);
          return await fsRead(opfsPath);
        }
      } catch { /* fall through */ }
    }
    let bytes: Uint8Array | null = null;
    if (gzB64) {
      await setStatus(`decoding ${label}…`);
      bytes = await decodeGzB64(gzB64);
    } else if (fetchUrl) {
      await setStatus(`fetching ${label}…`);
      const resp = await fetch(fetchUrl).catch(() => null);
      if (resp && resp.ok) bytes = new Uint8Array(await resp.arrayBuffer());
    }
    if (!bytes) return null;
    if (backend === "opfs" && fsWrite) {
      try {
        await setStatus(`writing ${label} to OPFS for next boot…`);
        await fsWrite(opfsPath, bytes);
      } catch { /* best-effort */ }
    }
    return bytes;
  };

  const seg = {
    name: "doom", version: "0.0.1",
    dependencies: ["app-host", "html-template-parser", "plastron-dom"], role: "application",
    cels: [
      { key: "doom.mount", celType: "FormulaCel",
        metadata: { key: "doom.mount", segment: "doom", parser: "f", inputMap: { active: "os.active" } },
        f: `(if (eq active "doom") "#app" null)` },
      { key: "doom.status", celType: "ValueCel",
        metadata: { key: "doom.status", segment: "doom" }, v: "" },
      { key: "doom.needs-wad", celType: "ValueCel",
        metadata: { key: "doom.needs-wad", segment: "doom" }, v: false },
      { key: "doom.wad-picker-display", celType: "FormulaCel",
        metadata: { key: "doom.wad-picker-display", segment: "doom", parser: "f",
                    inputMap: { needs: "doom.needs-wad" } },
        f: `(if needs "block" "none")` },
      {
        key: "doom.view", celType: "FormulaCel",
        metadata: { key: "doom.view", segment: "doom", parser: "html-template",
                    schema: "render-spec", channel: ["plastron-dom.paint"],
                    inputMap: { mount: "doom.mount", status: "doom.status",
                                wadPickerDisplay: "doom.wad-picker-display" } },
        f: `<div class="doom">
  <div class="toolbar">
    <button class="close" onClick={{(dispatch "os.exit")}}>×</button>
    <span>Doom</span>
    <span class="doom-status">{{status}}</span>
  </div>
  <canvas id="doom-screen" tabindex="0" width="640" height="400"></canvas>
  <label class="doom-wad-picker" style="display:{{wadPickerDisplay}};padding:.75rem">
    Choose a WAD to play:
    <input type="file" accept=".wad" onChange={{(dispatch "doom.wad-picked")}} />
  </label>
</div>`,
      },
      // Side-effect cel: re-fires whenever os.active changes. When the
      // formula evaluates with active==="doom", doom.maybe-boot RAF-defers
      // a single doom.boot.
      { key: "doom.auto-boot", celType: "FormulaCel",
        metadata: { key: "doom.auto-boot", segment: "doom", parser: "f",
                    inputMap: { active: "os.active" } },
        f: `(doom.maybe-boot active)` },
    ],
  };

  // Register doom.maybe-boot BEFORE hydrate so the auto-boot FormulaCel's
  // initial firing (against os.active="home") finds it. Without this the
  // first evaluation would CelError (formula references unregistered fn).
  await r("registerLambda")(state, {
    key: "doom.maybe-boot", kind: "custom",
    fn: (active: unknown): null => {
      if (active === "doom" && !doomHarness && !booting && typeof requestAnimationFrame === "function") {
        // Wait one frame so the painter has mounted #doom-screen.
        requestAnimationFrame(() => {
          const boot = r("doom.boot") as (...a: unknown[]) => Promise<unknown>;
          void boot(state);
        });
      }
      return null;
    },
  });

  await r("hydrate")(state, [seg], [{ name: "doom", version: "0.0.1", dependencies: seg.dependencies, role: "application" }]);

  // Internal: stand up the kind:"wasm" cel + start the harness, given
  // pre-fetched WAD bytes. Resolves doom.wasm from the bundle's inlined
  // base64 (preferred) or falls back to fetch (dev server).
  const bootEngineWith = async (wadBytes: Uint8Array, wadName: string): Promise<void> => {
    if (doomHarness) return;
    const canvas = typeof document !== "undefined"
      ? (document.getElementById("doom-screen") as HTMLCanvasElement | null)
      : null;
    if (!canvas) { await setStatus("no #doom-screen canvas in the DOM"); return; }

    const wasmBytes = await loadDoomAsset({
      opfsPath: "doom/doom.wasm",
      gzB64: DOOM_WASM_GZ_B64,
      fetchUrl: "./doom.wasm",
      label: "doom.wasm",
    });
    if (!wasmBytes) {
      await setStatus(`doom.wasm missing — rebuild plastron-os/bundle.ts to inline it, or deploy doom.wasm alongside the page`);
      return;
    }

    await setStatus("building harness…");
    const { createDoomHarness } = await import("../doom/doom-harness.js");
    doomHarness = createDoomHarness(wadBytes, {
      canvas, wadName,
      onLog: (line) => console.info("[doom]", line),
      onExit: (code) => console.info("[doom] proc_exit", code),
      // Sound omitted — the OS app doesn't wire env.snd_* into the sound
      // segment yet; the harness runs silently without the callbacks.
    });

    await setStatus("hydrating wasm cel…");
    await r("registerLambda")(state, {
      key: "doom-provider", segment: "doom", kind: "custom",
      fn: () => doomHarness!.provider(),
    });
    const runtimeSeg = {
      name: "doom-runtime", version: "0.0.1",
      dependencies: ["doom"], role: "application" as const,
      cels: [{
        key: "doom-wasm", celType: "EditableLambdaCel",
        metadata: { key: "doom-wasm", segment: "doom-runtime", kind: "wasm",
                    wasmExport: "doomgeneric_Create", imports: "doom-provider" },
        f: bytesToB64(wasmBytes),
      }],
    };
    await r("hydrate")(state, [runtimeSeg], [{
      name: "doom-runtime", version: "0.0.1",
      dependencies: runtimeSeg.dependencies, role: "application",
    }]);

    canvas.focus();
    doomHarness.start();
    await setStatus("running");
  };

  // doom.wad-picked — file-input change handler. Reads bytes from the
  // chosen file and starts the engine.
  await r("registerLambda")(state, {
    key: "doom.wad-picked", kind: "custom",
    fn: async (_st: unknown, _p: unknown, event: { target?: { files?: FileList | null } }): Promise<unknown> => {
      const file = event?.target?.files?.[0];
      if (!file) return state;
      const wadBytes = new Uint8Array(await file.arrayBuffer());
      await setNeedsWad(false);
      await bootEngineWith(wadBytes, file.name);
      return state;
    },
  });

  // doom.boot — main entry, called from doom.maybe-boot. Source order
  // for the WAD: inlined gz-b64 (bundle pre-pass) → fetch ./freedoom1.wad
  // (dev server) → user picker (page deployed without a sidecar WAD).
  await r("registerLambda")(state, {
    key: "doom.boot", segment: "doom", kind: "native", locked: true,
    fn: async (): Promise<unknown> => {
      if (doomHarness || booting) return state;
      booting = true;
      try {
        const wadBytes = await loadDoomAsset({
          opfsPath: "doom/freedoom1.wad",
          gzB64: DOOM_WAD_GZ_B64,
          fetchUrl: "./freedoom1.wad",
          label: "freedoom1.wad",
        });
        if (!wadBytes) {
          await setStatus("no WAD found alongside the page — please choose one");
          await setNeedsWad(true);
          return state;
        }
        await bootEngineWith(wadBytes, "freedoom1.wad");
      } catch (e) {
        await setStatus(`boot failed: ${(e as Error).message}`);
      } finally {
        booting = false;
      }
      return state;
    },
  });
};

// Decode gzip+base64 payloads inlined by bundle.ts (doom.wasm,
// freedoom1.wad). Uses the browser's DecompressionStream — ubiquitous in
// modern browsers; throws clearly off-browser, where this code never
// runs anyway.
async function decodeGzB64(b64: string): Promise<Uint8Array> {
  const bin = atob(b64);
  const gz = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) gz[i] = bin.charCodeAt(i);
  const stream = new Response(gz).body!.pipeThrough(
    new (globalThis as { DecompressionStream: typeof DecompressionStream }).DecompressionStream("gzip"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Inline base64 of a Uint8Array, chunked to avoid blowing the call stack
// (same shape as the standalone doom example).
const bytesToB64 = (b: Uint8Array): string => {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < b.length; i += chunk) bin += String.fromCharCode(...b.subarray(i, i + chunk));
  return btoa(bin);
};

// ── boot ────────────────────────────────────────────────────────────────────
await setupDesktop(state, [
  { id: "sheets", title: "Sheets", icon: "📊" },
  { id: "notepad", title: "Notepad", icon: "📝" },
  { id: "file-explorer", title: "Files", icon: "🗂" },
  { id: "doom", title: "Doom", icon: "🎮" },
]);
await setupFileToolbar(state);
await buildSheetsApp(state, {
  rows: 8, cols: 5,
  cells: { A1: "Item", B1: "Qty", C1: "Price", D1: "Total", A2: "Widget", B2: "3", C2: "4", D2: "=B2*C2", A3: "Gadget", B3: "5", C3: "2", D3: "=B3*C3", D4: "=D2+D3" },
});
await setupNotepad();
await setupFileExplorer(state);
await setupFilePicker(state);   // shared Open modal — must come AFTER setupFileExplorer
await setupDoom();

precompute(state);
await precomputeOptional(state);

// Reset boot defaults — the kernel's seed cels are shared object references
// across createInitialState calls (module-level cel instances), so a prior
// bootOS in the same process can leave os.active != "home". Resetting here
// makes "boot to home" deterministic.
await r("set")(state, "os.active", "home");
await r("set")(state, "os.doc", null);

if (typeof document !== "undefined") {
  setPainter(state, createPainter(state)); // host defaults: rAF + document
  await r("runCycle")(state);
  await r("drain")(state, "plastron-dom.paint");
  getPainter(state).drain(); // initial synchronous paint of the home screen
}

if (typeof window !== "undefined") {
  (window as unknown as { __plastron?: unknown }).__plastron = { state, resolveFn: (k: string) => resolveFn(state, k) };
}

return { state };
};

// Auto-boot in the browser; tests skip this branch by setting no document
// before importing, then explicitly call bootOS() after their mkEl setup.
const isBrowser = typeof window !== "undefined" && typeof document !== "undefined" && (document as unknown as { documentElement?: unknown }).documentElement !== undefined;
export const bootedState = isBrowser ? (await bootOS()).state : undefined;
