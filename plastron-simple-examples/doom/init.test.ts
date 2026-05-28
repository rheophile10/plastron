// Tests for the doom-init example. These prove the SAME load path the
// in-browser page exercises (main.ts), without a DOM:
//
//   1. The shipped doom.wasm artifact is well-formed (magic, size).
//   2. Its import surface matches the doom-harness contract exactly
//      (5 `env.*` shims + 14 wasi_snapshot_preview1 calls). If this set
//      changes the doom-harness design must be updated — the test is the
//      contract check.
//   3. Its export surface includes _initialize / doomgeneric_Create /
//      doomgeneric_Tick / memory.
//   4. The plastron load path — kind:"wasm" + wasm-host-instance — hands
//      the host the live instance with a 32 MB memory and the expected
//      exports, and _initialize runs cleanly against stub imports.
//
// What we explicitly do NOT test (yet):
//   - Rendering. There's no framebuffer blit; that's doom-harness.
//   - doomgeneric_Create. It would try to fopen the WAD and trap under
//     stub WASI — again, doom-harness territory.

import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../../plastron-simple/src/index.js";
import type { Fn } from "../../plastron-simple/src/index.js";

const WASM_PATH = new URL("./doom.wasm", import.meta.url).pathname;

// ── 1. Artifact present + well-formed ───────────────────────────────────────

test("doom.wasm is present and starts with the \\0asm magic header", async () => {
  const f = Bun.file(WASM_PATH);
  assert.equal(
    await f.exists(), true,
    `doom.wasm missing at ${WASM_PATH} — run \`bash ~/projects/wasm-factory/doom/build.sh\` then cp dist/doom.wasm here`,
  );
  const bytes = new Uint8Array(await f.arrayBuffer());
  assert.equal(bytes.length > 100_000, true, `doom.wasm suspiciously small (${bytes.length}B)`);
  assert.equal(bytes[0], 0x00);
  assert.equal(bytes[1], 0x61);
  assert.equal(bytes[2], 0x73);
  assert.equal(bytes[3], 0x6d);
});

// ── 2. Import surface = doom-harness contract ────────────────────────────────

test("doom.wasm imports the expected env.* (5) and wasi_snapshot_preview1.* (14)", async () => {
  const bytes = await Bun.file(WASM_PATH).arrayBuffer();
  const mod = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(mod);

  const env = imports.filter((i) => i.module === "env").map((i) => i.name).sort();
  assert.deepEqual(env, [
    "draw_frame", "get_key", "get_ticks_ms",
    "set_window_title", "sleep_ms",
    // The sound backend (doomgeneric_plastron_sound.c, built with
    // -DFEATURE_SOUND) adds these 5.
    "snd_init", "snd_is_playing", "snd_start", "snd_stop", "snd_update_params",
  ], "env namespace doesn't match doomgeneric_plastron{,_sound}.c — did the platform layer change?");

  const wasi = imports.filter((i) => i.module === "wasi_snapshot_preview1")
    .map((i) => i.name).sort();
  assert.deepEqual(wasi, [
    "fd_close", "fd_fdstat_get", "fd_fdstat_set_flags",
    "fd_prestat_dir_name", "fd_prestat_get",
    "fd_read", "fd_seek", "fd_write",
    "path_create_directory", "path_open",
    "path_remove_directory", "path_rename", "path_unlink_file",
    "proc_exit",
  ], "wasi surface changed — update doom-harness contract (1-design/.../doom-harness.md)");

  // No other namespaces snuck in.
  const namespaces = [...new Set(imports.map((i) => i.module))].sort();
  assert.deepEqual(namespaces, ["env", "wasi_snapshot_preview1"]);
});

// ── 3. Exports the host drives ───────────────────────────────────────────────

test("doom.wasm exports _initialize, doomgeneric_Create, doomgeneric_Tick, memory", async () => {
  const bytes = await Bun.file(WASM_PATH).arrayBuffer();
  const mod = new WebAssembly.Module(bytes);
  const exports = WebAssembly.Module.exports(mod);
  const byName = new Map(exports.map((e) => [e.name, e.kind]));

  assert.equal(byName.get("_initialize"), "function");
  assert.equal(byName.get("doomgeneric_Create"), "function");
  assert.equal(byName.get("doomgeneric_Tick"), "function");
  assert.equal(byName.get("memory"), "memory");
});

// ── 4. End-to-end through plastron — the load path main.ts uses ─────────────

test("loading doom.wasm through plastron (kind:\"wasm\" + wasm-host-instance) captures the live instance and _initialize runs cleanly", async () => {
  const bytes = new Uint8Array(await Bun.file(WASM_PATH).arrayBuffer());
  const b64 = Buffer.from(bytes).toString("base64");

  const state = createInitialState();
  const register = resolveFn(state, "registerLambda") as Fn;
  const hydrate  = resolveFn(state, "hydrate") as Fn;

  let onInstantiateCalls = 0;
  let captured: { exports: Record<string, unknown> } | null = null;

  // Stub provider: every import is a () => 0 (WASI errno SUCCESS).
  // onInstantiate is the wasm-host-instance hook — the compiler fires it
  // once with the live WebAssembly.Instance.
  await register(state, {
    key: "doom-stub-provider",
    fn: () => ({
      imports: { env: stubNs(), wasi_snapshot_preview1: stubNs() },
      onInstantiate: (instance: { exports: Record<string, unknown> }) => {
        onInstantiateCalls++;
        captured = instance;
      },
    }),
  });

  // Declarative hydrate is the only path that threads metadata.imports
  // through CompileContext; registerLambda would skip the hook.
  await hydrate(state, [{
    name: "doom",
    cels: [
      { key: "doom-wasm", celType: "EditableLambdaCel",
        metadata: { key: "doom-wasm", segment: "doom", kind: "wasm",
                    wasmExport: "doomgeneric_Create",
                    imports: "doom-stub-provider" },
        f: b64 },
    ],
  }], [{ name: "doom", version: "0.0.1", description: "doom init test", dependencies: [] }]);

  // Hook fired exactly once.
  assert.equal(onInstantiateCalls, 1, "onInstantiate should fire exactly once during hydrate");
  assert.ok(captured, "host should have captured the instance via onInstantiate");

  const cap = captured as { exports: Record<string, unknown> };
  assert.equal(typeof cap.exports._initialize,        "function");
  assert.equal(typeof cap.exports.doomgeneric_Create, "function");
  assert.equal(typeof cap.exports.doomgeneric_Tick,   "function");

  const memory = cap.exports.memory as { buffer: ArrayBuffer };
  assert.ok(memory.buffer instanceof ArrayBuffer, "memory export should be a WebAssembly.Memory");
  assert.equal(memory.buffer.byteLength, 33_554_432,
    "memory should be the --initial-memory=32MB the linker was told to use");

  // The walking-skeleton proof: _initialize runs to completion against
  // stub imports. If wasi-libc's ctors trap, this throws.
  (cap.exports._initialize as () => void)();
});

function stubNs(): Record<string, () => number> {
  // Proxy so the wasm module's specific import names all resolve to a
  // common no-op. Returning 0 is WASI errno SUCCESS, which is what most
  // of the static-init WASI calls expect.
  return new Proxy({}, { get: () => () => 0 }) as Record<string, () => number>;
}
