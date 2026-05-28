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
import { registerDocBinding } from "./doc-binding.js";

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

// ── Doom — real wasm harness, on-demand boot ────────────────────────────────
// Persistent doom segment hydrates a per-view-mount-gated <canvas> + a Start
// button. Clicking Start fires doom.boot which fetches /doom.wasm + /<wad>,
// builds the harness over the canvas, registers the provider cel,
// hydrate()s a tiny "doom-runtime" segment carrying the kind:"wasm" doom-wasm
// cel, then harness.start() runs _initialize + doomgeneric_Create + RAF tick.
// Idempotent — clicking Start twice is a no-op while a run is alive.
// See plastron-simple-examples/doom/doom-harness.ts for the harness contract.
const setupDoom = async (): Promise<void> => {
  // Lazy-import the harness so the OS bundle works even if the file isn't
  // sitting alongside (e.g. an out-of-tree build). Keeps the boot path off
  // module-init and lets bootOS pass when the canvas/fetch don't exist.
  type DoomHarnessModule = typeof import("../doom/doom-harness.js");
  let doomHarness: Awaited<ReturnType<DoomHarnessModule["createDoomHarness"]>> | null = null;
  let booting = false;

  const setStatus = async (msg: string): Promise<void> => {
    await (r("set") as (...a: unknown[]) => Promise<unknown>)(state, "doom.status", msg);
  };

  const seg = {
    name: "doom", version: "0.0.1",
    dependencies: ["app-host", "html-template-parser", "plastron-dom"], role: "application",
    cels: [
      { key: "doom.mount", celType: "FormulaCel",
        metadata: { key: "doom.mount", segment: "doom", parser: "f", inputMap: { active: "os.active" } },
        f: `(if (eq active "doom") "#app" null)` },
      { key: "doom.status", celType: "ValueCel",
        metadata: { key: "doom.status", segment: "doom" }, v: "click Start to launch the engine" },
      {
        key: "doom.view", celType: "FormulaCel",
        metadata: { key: "doom.view", segment: "doom", parser: "html-template",
                    schema: "render-spec", channel: ["plastron-dom.paint"],
                    inputMap: { mount: "doom.mount", status: "doom.status" } },
        f: `<div class="doom">
  <div class="toolbar">
    <button class="close" onClick={{(dispatch "os.exit")}}>×</button>
    <span>Doom</span>
    <button class="doom-start" onClick={{(dispatch doom.boot)}}>▶ Start engine</button>
    <span class="doom-status">{{status}}</span>
  </div>
  <canvas id="doom-screen" tabindex="0" width="640" height="400"></canvas>
</div>`,
      },
    ],
  };
  await r("hydrate")(state, [seg], [{ name: "doom", version: "0.0.1", dependencies: seg.dependencies, role: "application" }]);

  // doom.boot — the on-click action. Idempotent: a live harness short-circuits.
  await r("registerLambda")(state, {
    key: "doom.boot", segment: "doom", kind: "native", locked: true,
    fn: async (): Promise<unknown> => {
      if (doomHarness || booting) return state;
      booting = true;
      try {
        const canvas = (typeof document !== "undefined"
          ? (document.getElementById("doom-screen") as HTMLCanvasElement | null)
          : null);
        if (!canvas) { await setStatus("no #doom-screen canvas in the DOM"); return state; }

        await setStatus("fetching doom.wasm…");
        const wasmResp = await fetch("./doom.wasm");
        if (!wasmResp.ok) {
          await setStatus(`doom.wasm not found (HTTP ${wasmResp.status}) — see serve.ts`);
          return state;
        }
        const wasmBytes = new Uint8Array(await wasmResp.arrayBuffer());

        await setStatus("fetching freedoom1.wad…");
        const wadResp = await fetch("./freedoom1.wad");
        if (!wadResp.ok) {
          await setStatus(`freedoom1.wad not found (HTTP ${wadResp.status}) — see serve.ts`);
          return state;
        }
        const wadBytes = new Uint8Array(await wadResp.arrayBuffer());
        const wadName = "freedoom1.wad";

        await setStatus("building harness…");
        const { createDoomHarness } = await import("../doom/doom-harness.js");
        doomHarness = createDoomHarness(wadBytes, {
          canvas, wadName,
          onLog: (line) => console.info("[doom]", line),
          onExit: (code) => console.info("[doom] proc_exit", code),
          // Sound omitted — plastron-os has no sound segment yet; the harness
          // runs silently when these callbacks are missing.
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
      } catch (e) {
        await setStatus(`boot failed: ${(e as Error).message}`);
      } finally {
        booting = false;
      }
      return state;
    },
  });
};

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
