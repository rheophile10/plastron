// Headless validation of the doom-harness's WASI + env shim wiring.
//
// We can't render in Node/Bun (no canvas), and we may not have a WAD on
// hand. But the WASI half is DOM-free and testable: instantiate doom.wasm
// against an inline mirror of the harness's shim, run _initialize, then
// drive doomgeneric_Create with an empty WAD.
//
// Empty-WAD expected outcome: doom progresses far enough through WAD
// lookup to call I_Error ("no IWAD" or "WAD is corrupt"), which in
// wasi-libc routes through proc_exit — our shim throws a tagged error
// the test catches. Reaching that point cleanly proves:
//   • _initialize ran (libc ctors + WASI ctors all succeeded against the shim)
//   • path_open + fd_read are wired correctly enough for doomgeneric_Create
//     to *attempt* WAD parsing (rather than trapping in libc init).
//   • proc_exit terminates cleanly.
//
// If this test passes, the harness is "ready for a real WAD". The
// browser-side (canvas blit, RAF loop, keys) is then the last variable.

import { test } from "bun:test";
import assert from "node:assert/strict";

const WASM_PATH = new URL("./doom.wasm", import.meta.url).pathname;

// WASI errno + filetype constants (wasi_snapshot_preview1).
const E_SUCCESS = 0, E_BADF = 8, E_INVAL = 28, E_NOENT = 44, E_NOSYS = 52;
const FT_DIRECTORY = 3, FT_REGULAR_FILE = 4;
const FD_STDIN = 0, FD_STDOUT = 1, FD_STDERR = 2, FD_PREOPEN_ROOT = 3, FD_WAD = 4;

interface ShimResult {
  imports: Record<string, Record<string, (...a: never[]) => unknown>>;
  setInstance: (i: { exports: Record<string, unknown> }) => void;
  log: string[];
  exitCode: number | null;
}

function buildShim(wad: Uint8Array): ShimResult {
  let instance: { exports: Record<string, unknown> } | null = null;
  let wadFdOpen = false;
  let wadCursor = 0;
  let exitCode: number | null = null;
  const log: string[] = [];
  const stdio = ["", ""] as [string, string];

  const mem = () => {
    const buf = (instance!.exports.memory as WebAssembly.Memory).buffer;
    return { u8: new Uint8Array(buf), view: new DataView(buf) };
  };
  const flushStdio = (which: 0 | 1, chunk: string) => {
    const all = stdio[which] + chunk;
    const parts = all.split("\n");
    stdio[which] = parts.pop() ?? "";
    for (const p of parts) log.push(p);
  };

  // env: all no-ops; this test doesn't exercise rendering or sound. We
  // provide them so the module instantiates. Proxy auto-stubs any new
  // env import that future builds might add (e.g. music, network) so
  // this test doesn't need updating with every wasm-factory change.
  const env = new Proxy({}, { get: () => () => 0 });

  const wasi = {
    fd_close: (fd: number) => {
      if (fd === FD_WAD) { wadFdOpen = false; wadCursor = 0; }
      return E_SUCCESS;
    },
    fd_fdstat_get: (fd: number, buf: number) => {
      const valid =
        fd === FD_STDIN || fd === FD_STDOUT || fd === FD_STDERR ||
        fd === FD_PREOPEN_ROOT || (fd === FD_WAD && wadFdOpen);
      if (!valid) return E_BADF;
      const m = mem();
      m.view.setUint8(buf, fd === FD_PREOPEN_ROOT ? FT_DIRECTORY : FT_REGULAR_FILE);
      m.view.setUint16(buf + 2, 0, true);
      m.view.setBigUint64(buf + 8,  0xffffffffffffffffn, true);
      m.view.setBigUint64(buf + 16, 0xffffffffffffffffn, true);
      return E_SUCCESS;
    },
    fd_fdstat_set_flags: () => E_SUCCESS,
    fd_prestat_get: (fd: number, buf: number) => {
      if (fd !== FD_PREOPEN_ROOT) return E_BADF;
      const m = mem();
      m.view.setUint8(buf, 0); // tag = directory
      m.view.setUint32(buf + 4, 1, true);
      return E_SUCCESS;
    },
    fd_prestat_dir_name: (fd: number, ptr: number, len: number) => {
      if (fd !== FD_PREOPEN_ROOT) return E_BADF;
      if (len < 1) return E_INVAL;
      mem().u8[ptr] = 0x2f; // '/'
      return E_SUCCESS;
    },
    fd_read: (fd: number, iovs: number, iovs_len: number, nread_ptr: number) => {
      const m = mem();
      if (fd === FD_STDIN) { m.view.setUint32(nread_ptr, 0, true); return E_SUCCESS; }
      if (fd !== FD_WAD || !wadFdOpen) return E_BADF;
      let total = 0;
      for (let i = 0; i < iovs_len; i++) {
        const ent = iovs + i * 8;
        const buf = m.view.getUint32(ent, true);
        const len = m.view.getUint32(ent + 4, true);
        const avail = wad.length - wadCursor;
        const n = Math.min(len, Math.max(0, avail));
        if (n > 0) {
          m.u8.set(wad.subarray(wadCursor, wadCursor + n), buf);
          wadCursor += n; total += n;
        }
        if (n < len) break;
      }
      m.view.setUint32(nread_ptr, total, true);
      return E_SUCCESS;
    },
    fd_seek: (fd: number, offset: bigint, whence: number, newoff_ptr: number) => {
      if (fd !== FD_WAD || !wadFdOpen) return E_BADF;
      const off = Number(offset);
      let next: number;
      if      (whence === 0) next = off;
      else if (whence === 1) next = wadCursor + off;
      else if (whence === 2) next = wad.length + off;
      else return E_INVAL;
      if (next < 0) return E_INVAL;
      wadCursor = next;
      mem().view.setBigUint64(newoff_ptr, BigInt(wadCursor), true);
      return E_SUCCESS;
    },
    fd_write: (fd: number, iovs: number, iovs_len: number, nwritten_ptr: number) => {
      if (fd !== FD_STDOUT && fd !== FD_STDERR) {
        mem().view.setUint32(nwritten_ptr, 0, true);
        return E_SUCCESS;
      }
      const m = mem();
      let total = 0, str = "";
      for (let i = 0; i < iovs_len; i++) {
        const ent = iovs + i * 8;
        const buf = m.view.getUint32(ent, true);
        const len = m.view.getUint32(ent + 4, true);
        str += new TextDecoder().decode(m.u8.subarray(buf, buf + len));
        total += len;
      }
      m.view.setUint32(nwritten_ptr, total, true);
      if (str) flushStdio(fd === FD_STDOUT ? 0 : 1, str);
      return E_SUCCESS;
    },
    path_open: (
      _dirfd: number, _dirflags: number,
      path_ptr: number, path_len: number,
      _o: number, _rb: bigint, _ri: bigint, _f: number,
      fd_out_ptr: number,
    ) => {
      const m = mem();
      const path = new TextDecoder().decode(m.u8.subarray(path_ptr, path_ptr + path_len));
      const base = path.split(/[\\/]/).pop()!;
      // Match only "doom1.wad" so doom identifies the (empty) bytes as
      // Doom 1 shareware and traces the IWAD-validation path cleanly.
      if (base.toLowerCase() !== "doom1.wad") return E_NOENT;
      if (wadFdOpen) return E_INVAL;
      wadFdOpen = true; wadCursor = 0;
      m.view.setUint32(fd_out_ptr, FD_WAD, true);
      return E_SUCCESS;
    },
    path_create_directory: () => E_NOSYS,
    path_remove_directory: () => E_NOSYS,
    path_rename:           () => E_NOSYS,
    path_unlink_file:      () => E_NOSYS,
    proc_exit: (code: number): never => {
      exitCode = code;
      throw new Error(`proc_exit(${code})`);
    },
  };

  return {
    imports: { env, wasi_snapshot_preview1: wasi },
    setInstance: (i) => { instance = i; },
    log,
    get exitCode() { return exitCode; },
  } as ShimResult;
}

test("doom.wasm instantiates against the harness's WASI shim", async () => {
  const wasm = await Bun.file(WASM_PATH).arrayBuffer();
  const shim = buildShim(new Uint8Array(0));
  const { instance } = await WebAssembly.instantiate(wasm, shim.imports);
  shim.setInstance(instance);
  // The four exports we contracted for.
  assert.equal(typeof instance.exports._initialize, "function");
  assert.equal(typeof instance.exports.doomgeneric_Create, "function");
  assert.equal(typeof instance.exports.doomgeneric_Tick, "function");
  assert.ok((instance.exports.memory as WebAssembly.Memory).buffer instanceof ArrayBuffer);
});

test("_initialize runs cleanly against the WASI shim (libc ctors + WASI preopens enumerated)", async () => {
  const wasm = await Bun.file(WASM_PATH).arrayBuffer();
  const shim = buildShim(new Uint8Array(0));
  const { instance } = await WebAssembly.instantiate(wasm, shim.imports);
  shim.setInstance(instance);
  (instance.exports._initialize as () => void)();
});

test("doomgeneric_Create with empty WAD progresses to I_Error → proc_exit (shim mechanics validated)", async () => {
  const wasm = await Bun.file(WASM_PATH).arrayBuffer();
  // Empty WAD: doom's IWAD scan finds no playable WAD and calls I_Error
  // (→ proc_exit). Reaching that proves _initialize ran, the preopen
  // enumeration succeeded, path_open got called for doom1.wad, fd_read
  // attempted (returning 0 bytes), and proc_exit fired. A pre-IWAD trap
  // would mean the shim is broken — this test catches that.
  const shim = buildShim(new Uint8Array(0));
  const { instance } = await WebAssembly.instantiate(wasm, shim.imports);
  shim.setInstance(instance);
  (instance.exports._initialize as () => void)();

  let threw: Error | null = null;
  try {
    (instance.exports.doomgeneric_Create as (a: number, b: number) => void)(0, 0);
  } catch (e) {
    threw = e as Error;
  }
  assert.ok(threw, "doomgeneric_Create should reach I_Error → proc_exit (host-thrown) with no WAD");
  assert.match(threw!.message, /proc_exit/, `expected a proc_exit throw, got: ${threw!.message}`);
  // The shim is wired correctly iff doom traversed:
  //   _initialize → libc init → doomgeneric_Create → argc=0/argv=NULL path
  //   → Z_Init (heap) → V_Init (screen buffer) → M_LoadDefaults (config)
  //   → IWAD scan (path_open hits) → W_Init (fd_read of the WAD) → I_Error
  // We assert milestones (not the full log; doomgeneric versions tweak text).
  const haystack = shim.log.join("\n");
  for (const milestone of [
    "Doom Generic",          // banner — _initialize + ctors worked
    "Z_Init",                // zone allocator initialized
    "V_Init",                // screen buffer allocated
    "M_LoadDefaults",        // config path (our path_open NOENT → defaults)
    "Trying IWAD file",      // argc=0/argv=NULL flow into IWAD scan
    "W_Init",                // path_open hit + fd_read attempted
    "doesn't have IWAD",     // expected I_Error: bytes weren't a real WAD
  ]) {
    assert.match(haystack, new RegExp(milestone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `missing milestone "${milestone}" in doom output:\n${haystack}`);
  }
});
