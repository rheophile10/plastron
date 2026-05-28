// Real-WAD test: drive doom.wasm through doomgeneric_Create + N ticks
// against an actual IWAD, headlessly, using the SAME doom-harness.ts the
// browser uses (the harness is given a stub DOM via globalThis). Asserts:
//
//   • doomgeneric_Create succeeds (the WAD parses, IWAD detection works).
//   • A RAF tick draws at least one frame (env.draw_frame fires).
//   • At least one frame is non-empty (the engine actually rendered pixels,
//     not just a zeroed framebuffer).
//
// Pre-req: a real WAD at $FREEDOOM_WAD (default
// ~/test-wads/freedoom-0.13.0/freedoom1.wad). The test SKIPS if the file
// is missing, so it doesn't fail for users without freedoom installed.
// To set up: see plastron-simple-examples/doom/README.md.

import { test, beforeAll, afterAll } from "bun:test";
import assert from "node:assert/strict";

const WAD_PATH = process.env.FREEDOOM_WAD ??
  `${process.env.HOME}/test-wads/freedoom-0.13.0/freedoom1.wad`;
const WASM_PATH = new URL("./doom.wasm", import.meta.url).pathname;

// ── DOM stubs ────────────────────────────────────────────────────────────────
// The harness uses a small DOM surface (canvas/context/ImageData, document
// for window title, window/document addEventListener for keys, RAF). We
// install minimal globals that record what the harness does — captured
// frames go into `capturedFrames`, RAF callbacks queue up so we can drive
// the loop manually.

interface CapturedFrame { firstPixels: number[]; nonZeroPixels: number; }

interface DomStub {
  capturedFrames: CapturedFrame[];
  rafQueue: FrameRequestCallback[];
  canvas: HTMLCanvasElement;
  cleanup: () => void;
}

function installDomStub(): DomStub {
  const capturedFrames: CapturedFrame[] = [];
  const rafQueue: FrameRequestCallback[] = [];

  // Single ImageData shared across draws — putImageData snapshots it.
  const sharedImage = {
    data: new Uint8ClampedArray(640 * 400 * 4),
    width: 640, height: 400,
  };
  const ctx = {
    createImageData: (_w: number, _h: number) => sharedImage,
    putImageData: (img: { data: Uint8ClampedArray }) => {
      const u32 = new Uint32Array(img.data.buffer);
      let nonZero = 0;
      for (let i = 0; i < u32.length; i++) {
        if ((u32[i] & 0x00ffffff) !== 0) nonZero++;
      }
      capturedFrames.push({ firstPixels: [...u32.slice(0, 16)], nonZeroPixels: nonZero });
    },
  };

  const canvas = {
    width: 0, height: 0,
    getContext: (_kind: string) => ctx,
    focus: () => {},
  } as unknown as HTMLCanvasElement;

  // Save originals so we can restore — important for not polluting other tests.
  const g = globalThis as unknown as Record<string, unknown>;
  const orig = {
    raf:  g.requestAnimationFrame,
    caf:  g.cancelAnimationFrame,
    doc:  g.document,
    win:  g.window,
  };

  g.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  }) as typeof requestAnimationFrame;
  g.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
  g.document = {
    title: "",
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Document;
  g.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Window;

  return {
    capturedFrames, rafQueue, canvas,
    cleanup: () => {
      g.requestAnimationFrame = orig.raf as typeof requestAnimationFrame;
      g.cancelAnimationFrame  = orig.caf as typeof cancelAnimationFrame;
      g.document = orig.doc as Document;
      g.window   = orig.win as Window;
    },
  };
}

// ── Conditional skip if no WAD ───────────────────────────────────────────────

const wadExists = await Bun.file(WAD_PATH).exists();
const runIf = wadExists ? test : test.skip;

if (!wadExists) {
  console.log(`SKIP: real-WAD tests — no WAD at ${WAD_PATH}`);
  console.log(`  To enable, fetch freedoom (free WAD; ~30MB) — see README.md.`);
}

// ── Setup ────────────────────────────────────────────────────────────────────

let wasmBytes: ArrayBuffer;
let wadBytes: Uint8Array;
let dom: DomStub;
let harness: import("./doom-harness.js").DoomHarness;
let logs: string[] = [];

beforeAll(async () => {
  if (!wadExists) return;
  wasmBytes = await Bun.file(WASM_PATH).arrayBuffer();
  wadBytes  = new Uint8Array(await Bun.file(WAD_PATH).arrayBuffer());
  dom = installDomStub();

  // Dynamic import so the DOM stubs are in place before doom-harness.ts loads.
  const { createDoomHarness } = await import("./doom-harness.js");
  harness = createDoomHarness(wadBytes, {
    canvas: dom.canvas,
    wadName: "freedoom1.wad",
    onLog: (line) => logs.push(line),
    onExit: () => {},
  });
});

afterAll(() => {
  if (wadExists) dom?.cleanup();
});

// ── Tests ────────────────────────────────────────────────────────────────────

runIf("real WAD: harness drives doom through full Create init against the real WAD", async () => {
  const env = harness.provider();
  const { instance } = await WebAssembly.instantiate(wasmBytes, env.imports);
  env.onInstantiate(instance);
  harness.start();
  assert.equal(harness.state().initialized, true, "_initialize did not run");

  const haystack = logs.join("\n");
  // Doom's full Create-time init sequence — every one of these requires
  // working WASI (fd_write, path_open + fd_read for WAD lumps, fd_seek
  // for lump offsets, fd_close on done) AND clean function-pointer
  // dispatch (R_Init, P_Init set up state machines that exercise
  // call_indirect heavily). If any are missing, something regressed.
  for (const milestone of [
    "Doom Generic",          // banner
    "Z_Init",                // zone allocator
    "V_Init",                // screen buffer alloc
    "M_LoadDefaults",        // config-file path (NOENT → defaults)
    "Ultimate Doom",         // ← correct IWAD identification (freedoom1 = Doom1)
    "I_Init: Setting up machine state",
    "M_Init",                // miscellaneous init
    "R_Init",                // refresh / renderer
    "P_Init",                // playloop state (function-pointer tables — was the trap site!)
    "S_Init",                // sound subsystem
    "D_CheckNetGame",        // network check
    "HU_Init",               // heads-up display
    "ST_Init",               // status bar
    "I_InitGraphics",        // framebuffer init (where DG_ScreenBuffer becomes live)
  ]) {
    assert.match(haystack, new RegExp(milestone),
      `missing "${milestone}" in:\n${haystack}`);
  }
  // The empty-WAD error must NOT fire — proof path_open + fd_read
  // served the right WAD AND doom identified the game correctly.
  assert.doesNotMatch(haystack, /doesn't have IWAD or PWAD id/);
  // No engine trap of any kind — the call_indirect bug is fixed
  // (G_CheckDemoStatus patch in wasm-factory + exact-match path_open).
  assert.doesNotMatch(haystack, /doomgeneric_(Create|Tick) threw/,
    "engine should no longer trap after the doomgeneric+harness patches");
});

runIf("real WAD: harness.provider() returns the expected shape (the doom-harness contract)", () => {
  // Structural check — the provider must return both imports namespaces
  // doom.wasm declares (env + wasi_snapshot_preview1), each with the
  // exact functions the wasm-side import list names. This catches
  // accidental rename/omission regressions in doom-harness.ts without
  // depending on how far the engine runs before the call_indirect trap.
  const env = harness.provider();
  assert.equal(typeof env.onInstantiate, "function");
  assert.equal(typeof env.dispose, "function");
  assert.ok(env.imports.env, "missing env namespace");
  assert.ok(env.imports.wasi_snapshot_preview1, "missing wasi namespace");

  // env.* — 5 platform + 5 sound = 10.
  const envNames = Object.keys(env.imports.env).sort();
  assert.deepEqual(envNames, [
    "draw_frame", "get_key", "get_ticks_ms",
    "set_window_title", "sleep_ms",
    "snd_init", "snd_is_playing", "snd_start", "snd_stop", "snd_update_params",
  ]);

  // Exactly the 14 wasi calls doom.wasm imports.
  const wasiNames = Object.keys(env.imports.wasi_snapshot_preview1).sort();
  assert.deepEqual(wasiNames, [
    "fd_close", "fd_fdstat_get", "fd_fdstat_set_flags",
    "fd_prestat_dir_name", "fd_prestat_get",
    "fd_read", "fd_seek", "fd_write",
    "path_create_directory", "path_open",
    "path_remove_directory", "path_rename", "path_unlink_file",
    "proc_exit",
  ]);
});

// ── CHARACTERIZATION: doomgeneric_Tick currently traps on wasm CFI ──────────
// doomgeneric uses a union'd `actionf_t` (info.h) where game-state
// "action" functions are stored under one field but called with
// different effective signatures (some `void(*)(mobj_t*)`, some
// `void(*)(player_t*, pspdef_t*)`). On native x86 this is OK because
// the calling convention happens to match; on wasm, `call_indirect`
// type-checks against the table's declared function type and traps on
// a mismatch.
//
// This test documents the CURRENT bug. When doomgeneric is patched
// (actionf_t unified, or wrapper trampolines added) and rebuilt, this
// test will fail — at which point flip it to the "non-empty frames"
// assertion the original intent expected. Next-step tracking lives in
// the doom-harness roadmap entry.

runIf("real WAD: ticking with RAF cadence produces non-empty frames (DOOM IS RENDERING)", async () => {
  // Doom is locked to 35 FPS internally via DG_GetTicksMs. We pace
  // ticks at ~16ms (matching browser RAF at 60Hz) so doom's timing
  // logic advances and DG_DrawFrame actually fires.
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  let ticked = 0;
  const beforeFrames = dom.capturedFrames.length;
  for (let i = 0; i < 60; i++) {
    const next = dom.rafQueue.shift();
    if (!next) break;
    next(performance.now());
    ticked++;
    await sleep(16);
  }
  assert.ok(ticked > 0, "no RAF ticks ran");

  const newFrames = dom.capturedFrames.slice(beforeFrames);
  assert.ok(newFrames.length > 0,
    `expected ≥1 new frame from the tick loop; got 0.\nlogs:\n${logs.join("\n")}`);

  // At least one captured frame has non-zero pixels — doom's title pic
  // / logos / status bar / level geometry. Black-only would mean either
  // env.draw_frame isn't firing or DG_ScreenBuffer is never written.
  const bestFrame = newFrames.reduce((m, f) => f.nonZeroPixels > m.nonZeroPixels ? f : m);
  assert.ok(bestFrame.nonZeroPixels > 1000,
    `best frame had only ${bestFrame.nonZeroPixels} non-zero pixels ` +
    `(of ${640*400}); expected ≥1000. ${newFrames.length} frames captured. ` +
    `If this fails the engine is ticking but DG_ScreenBuffer stays empty ` +
    `(check env.draw_frame fb_ptr / color order). First-pixel sample: ` +
    `${bestFrame.firstPixels.map((p) => p.toString(16).padStart(8,"0")).join(" ")}`);
});

runIf("real WAD: framesDrawn counter from the harness matches captured frames", () => {
  // Sanity: the harness's own counter agrees with what our DOM stub saw.
  // If these diverge, something is wrong with the rendering plumbing.
  assert.equal(harness.state().framesDrawn, dom.capturedFrames.length);
});

runIf("real WAD: harness.stop() cancels the RAF loop", () => {
  const before = dom.rafQueue.length;
  harness.stop();
  // After stop(), the harness's loop won't reschedule, so the queue stays
  // at the current length when we drain it.
  if (before > 0) {
    // Run pending ticks — they should NOT re-enqueue more.
    while (dom.rafQueue.length > 0) {
      const next = dom.rafQueue.shift()!;
      next(performance.now());
    }
  }
  assert.equal(harness.state().stopped, true);
  // Queue is now empty and stays empty.
  assert.equal(dom.rafQueue.length, 0);
});
