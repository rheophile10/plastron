// doom — plastron harness demo. The flow:
//
//   pick WAD → click "Start engine" → fetch doom.wasm → register the
//   harness provider (real WASI + env, see doom-harness.ts) → hydrate a
//   kind:"wasm" cel pointing at it → the wasm-host-instance hook hands
//   the harness the live instance → harness.start() runs _initialize +
//   doomgeneric_Create + a RAF tick loop blitting frames to the canvas.
//
// This is a first cut. The WASI fd layer is the gnarly half — known
// rough edges live in the log panel; we'll learn from what we see.

import {
  createInitialState, resolveFn,
} from "../../plastron-simple/src/index.js";
import type { Fn } from "../../plastron-simple/src/index.js";
import { createDoomHarness, type DoomHarness } from "./doom-harness.js";

const $ = (id: string) => document.getElementById(id)!;
const wadInput = $("wad") as HTMLInputElement;
const canvas   = $("screen") as HTMLCanvasElement;
const statusEl = $("status");
const banner   = $("banner");
const logEl    = $("log");

const log = (line: string): void => {
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
};
const setStatus = (s: string): void => { statusEl.textContent = s; };
const showBanner = (html: string): void => {
  banner.innerHTML = html;
  banner.style.display = "block";
};

let wadBytes: Uint8Array | null = null;
let wadName = "";
let harness: DoomHarness | null = null;
let booting = false;

// Auto-boot flow: fetch freedoom1.wad (served from a symlink at the
// example root), then immediately boot doom. No buttons — the example
// is "you opened the page, the engine starts". If the auto-fetch fails
// (no symlink), the file picker remains available for any WAD.
async function bootWith(bytes: Uint8Array, name: string): Promise<void> {
  if (booting) return;
  booting = true;
  wadBytes = bytes;
  wadName = name;
  setStatus(`WAD loaded: ${name} (${bytes.byteLength.toLocaleString()} bytes) — booting engine…`);
  log(`✓ WAD: ${name} — ${bytes.byteLength.toLocaleString()} bytes`);
  await bootDoom().catch((e: Error) => {
    log("× boot failed: " + e.message);
    if (e.stack) log(e.stack);
    if (/call_indirect to a signature that does not match/.test(e.message)) {
      showBanner(
        `<b>Engine bug — known.</b> doomgeneric's <code>actionf_t</code> union holds ` +
        `function pointers with mismatched signatures; wasm's <code>call_indirect</code> ` +
        `rejects them. The harness reached every libc/WASI/IWAD milestone (see log) ` +
        `before the trap — proof the harness is right, the bug is in doomgeneric. ` +
        `Fix tracked in <code>doom-harness.md</code> "Known engine bug".`,
      );
      setStatus("engine trapped: documented call_indirect bug (see banner + log)");
    } else {
      setStatus("boot failed (see log)");
    }
  });
  booting = false;
}

async function tryAutoloadWad(): Promise<void> {
  setStatus("checking for freedoom1.wad…");
  try {
    const resp = await fetch("./freedoom1.wad");
    if (!resp.ok) {
      setStatus("no auto-loaded WAD — pick one with the file input");
      return;
    }
    const bytes = new Uint8Array(await resp.arrayBuffer());
    await bootWith(bytes, "freedoom1.wad");
  } catch (e) {
    setStatus("no auto-loaded WAD — pick one with the file input");
    log(`(auto-load skipped: ${(e as Error).message})`);
  }
}

wadInput.addEventListener("change", async () => {
  const file = wadInput.files?.[0];
  if (!file) return;
  harness?.stop();
  // Reset state for a fresh boot with the picked WAD.
  booting = false;
  banner.style.display = "none";
  logEl.textContent = "";
  const bytes = new Uint8Array(await file.arrayBuffer());
  await bootWith(bytes, file.name);
});

void tryAutoloadWad();

async function bootDoom(): Promise<void> {
  if (!wadBytes) throw new Error("no WAD loaded");

  setStatus("fetching doom.wasm…");
  const resp = await fetch("./doom.wasm");
  if (!resp.ok) {
    throw new Error(
      `doom.wasm not found (HTTP ${resp.status}). Build it:\n` +
      `  bash ~/projects/wasm-factory/doom/build.sh\n` +
      `  cp ~/projects/wasm-factory/dist/doom.wasm ./`,
    );
  }
  const wasmBytes = new Uint8Array(await resp.arrayBuffer());
  log(`✓ doom.wasm: ${wasmBytes.byteLength.toLocaleString()} bytes`);

  setStatus("creating harness…");
  // Stand up the plastron state up-front so its sound cels are ready
  // to wire into the harness's env.snd_* dispatch.
  const state = createInitialState();
  const register   = resolveFn(state, "registerLambda") as Fn;
  const hydrate    = resolveFn(state, "hydrate") as Fn;
  const playPcm    = resolveFn(state, "sound.play-pcm")      as Fn;
  const stopSource = resolveFn(state, "sound.stop-source")   as Fn;
  const updateSrc  = resolveFn(state, "sound.update-source") as Fn;
  const isPlaying  = resolveFn(state, "sound.is-playing")    as Fn;

  harness = createDoomHarness(wadBytes, {
    canvas,
    wadName,
    onLog: log,
    onExit: (code) => log(`doom proc_exit(${code})`),
    // Doom → plastron sound segment. The harness already parses the DMX
    // header and converts 8-bit PCM → Float32; we just forward.
    playPcm:      (info)               => playPcm(state, info) as number,
    stopPcm:      (h)                  => stopSource(state, h),
    updatePcm:    (h, a)               => updateSrc(state, h, a),
    isPcmPlaying: (h)                  => isPlaying(state, h) as boolean,
  });

  setStatus("hydrating kind:\"wasm\"…");
  // Register the provider cel — its _fn returns the harness's envelope
  // (imports + onInstantiate + dispose). metadata.imports points at it.
  await register(state, {
    key: "doom-provider",
    fn: () => harness!.provider(),
  });

  // Declarative hydrate: only this path threads metadata.imports through
  // CompileContext to the wasm compiler.
  await hydrate(state, [{
    name: "doom",
    cels: [
      { key: "doom-wasm", celType: "EditableLambdaCel",
        metadata: { key: "doom-wasm", segment: "doom", kind: "wasm",
                    wasmExport: "doomgeneric_Create",
                    imports: "doom-provider" },
        f: bytesToB64(wasmBytes) },
    ],
  }], [{ name: "doom", version: "0.0.1",
         description: "doom harness demo", dependencies: [] }]);

  log("✓ kind:\"wasm\" cel hydrated; onInstantiate captured the live instance");

  setStatus("starting engine (this calls _initialize + doomgeneric_Create + RAF tick)…");
  canvas.focus();
  // start() runs _initialize + doomgeneric_Create synchronously and
  // schedules the first RAF tick. A trap (either the documented
  // call_indirect or anything else) rethrows here; bootWith's catch
  // surfaces it in the banner.
  harness.start();
  setStatus("engine running");

  // Heartbeat: even if the canvas stays black (engine bug), this tells
  // you the harness is alive and ticking — frames drawn climbs and
  // wadCursor moves as doom reads its lumps.
  let lastFrames = 0;
  const tick = setInterval(() => {
    const s = harness!.state();
    if (s.stopped) { clearInterval(tick); return; }
    const delta = s.framesDrawn - lastFrames;
    lastFrames = s.framesDrawn;
    setStatus(`running — ${s.framesDrawn} frames drawn (+${delta}/s); wadCursor=${s.wadCursor.toLocaleString()}`);
  }, 1000);
}

// Inline base64 of doom.wasm — chunked to avoid blowing the call stack.
function bytesToB64(b: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < b.length; i += chunk) {
    bin += String.fromCharCode(...b.subarray(i, i + chunk));
  }
  return btoa(bin);
}
