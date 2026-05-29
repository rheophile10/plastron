// doom-harness — the real implementation of the 19 imports doom.wasm
// declares (verified by init.test.ts):
//   • env.* (5)  — draw_frame, get_ticks_ms, sleep_ms, get_key, set_window_title
//   • wasi_snapshot_preview1.* (14)
//
// Public surface:
//
//   const harness = createDoomHarness(wadBytes, { canvas, onLog, onExit });
//   // ... hydrate a kind:"wasm" cel with metadata.imports pointing at a
//   // provider cel whose _fn returns harness.provider() ...
//   harness.start();   // _initialize + doomgeneric_Create + RAF loop
//   harness.stop();    // cancel RAF + dispose
//
// Honest scoping:
//   • The WASI shim is the minimum viable subset to satisfy wasi-libc's
//     ctors and serve a single read-only "doom1.wad" via a preopen at "/".
//     Path-mutation ops return ENOSYS. Save games / config files return
//     ENOENT — doom uses defaults.
//   • Memory: each call freshly derives DataView from instance.exports.memory.buffer
//     to survive memory.grow detachments.
//   • argv: we call doomgeneric_Create(0, 0). doomgeneric's M_FindResponseFile
//     handles argc=0 cleanly, and D_DoomMain's M_CheckParm just returns 0
//     for every "-foo" probe — defaults all the way down.
//   • This is a first cut. Expect iteration on errno values, fdstat shape,
//     and the framebuffer color order. Bugs surface as engine traps or
//     wrong-color rendering; we'll learn from them.

export interface WasmInstance { exports: Record<string, unknown>; }

export interface DoomHarnessOptions {
  canvas: HTMLCanvasElement;
  /** The WAD's filename (e.g. "freedoom1.wad", "doom1.wad"). path_open
   *  serves the bytes ONLY when doom asks for this name — doom scans
   *  many IWAD names in order and we want it to pick the right one so
   *  it identifies the game correctly. Defaults to "doom1.wad". */
  wadName?: string;
  onLog?: (line: string) => void;
  onExit?: (code: number) => void;

  // ── sound dispatch (optional — silent without it) ──────────────────────
  // The harness parses doom's DMX SFX header (rate + PCM offset) and
  // converts 8-bit unsigned PCM → Float32. It hands the result to these
  // callbacks. Wire them to your audio backend (e.g. plastron's
  // `sound.play-pcm` + `sound.stop-source` + `sound.update-source`).
  //
  // doom-side conventions:
  //   - channel: 0..15 (logical, picked by doom)
  //   - vol:     0..127  (we normalize to 0..1 before calling)
  //   - sep:     0..254  (128 = center; we map to pan -1..1)

  /** Start a PCM source. Return a non-zero handle the harness will track
   *  on `channel`. Returning 0 indicates "didn't play" (and `is_playing`
   *  for that channel will report false). */
  playPcm?: (info: {
    samples: Float32Array; rate: number;
    channel: number; gain: number; pan: number;
  }) => number;
  /** Stop the source that started with the given handle. */
  stopPcm?: (handle: number) => void;
  /** Update gain/pan on a live source. */
  updatePcm?: (handle: number, args: { gain: number; pan: number }) => void;
  /** Return true if `handle` is still playing. */
  isPcmPlaying?: (handle: number) => boolean;
}

export interface ImportsEnvelope {
  imports: Record<string, Record<string, (...args: unknown[]) => unknown>>;
  onInstantiate: (instance: WasmInstance) => void;
  dispose: () => void;
}

export interface DoomHarness {
  /** What `metadata.imports` resolves to — register a cel whose _fn
   *  returns this envelope, then point a kind:"wasm" cel at it. */
  provider: () => ImportsEnvelope;
  /** Run _initialize, then doomgeneric_Create, then drive doomgeneric_Tick
   *  on requestAnimationFrame. Call AFTER hydrate (so onInstantiate has
   *  fired and the instance is captured). */
  start: () => void;
  stop: () => void;
  /** Status snapshot for the UI. */
  state: () => { initialized: boolean; started: boolean; stopped: boolean; framesDrawn: number; wadCursor: number };
}

const DG_RESX = 640;
const DG_RESY = 400;

// WASI errno (wasi-snapshot-preview1). The full table is large; we only
// reference the few we need.
const E_SUCCESS = 0;
const E_BADF    = 8;
const E_INVAL   = 28;
const E_NOENT   = 44;
const E_NOSYS   = 52;

// WASI filetype tags.
const FILETYPE_DIRECTORY    = 3;
const FILETYPE_REGULAR_FILE = 4;

// WASI preopen tag (0 = directory).
const PREOPENTYPE_DIR = 0;

// The fd numbers we hand out. 0/1/2 stdio; 3 the preopened root "/"; 4
// the WAD when libc fopen's it.
const FD_STDIN  = 0;
const FD_STDOUT = 1;
const FD_STDERR = 2;
const FD_PREOPEN_ROOT = 3;
const FD_WAD          = 4;

// Match only the user's WAD by basename (case-insensitive). doomgeneric
// scans IWAD names in a fixed order (doom2.wad, plutonia.wad, tnt.wad,
// doom.wad, doom1.wad, ..., freedoom1.wad, ... — see d_iwad.c) and
// identifies the game by which filename matched. If we served the bytes
// under "doom2.wad" but they're actually Phase 1 freedoom, doom would
// mis-identify the game type → look for Doom-2-specific lumps that
// don't exist → I_Error. Serving only under the user's actual filename
// makes doom's identification accurate.
const matchesWad = (basename: string, wadName: string): boolean =>
  basename.toLowerCase() === wadName.toLowerCase();

export function createDoomHarness(
  wadBytes: Uint8Array,
  opts: DoomHarnessOptions,
): DoomHarness {
  const { canvas,
          wadName = "doom1.wad",
          onLog = () => {},
          onExit = () => {},
          playPcm, stopPcm, updatePcm, isPcmPlaying } = opts;
  // ── Mutable state ──────────────────────────────────────────────────────
  let instance: WasmInstance | null = null;
  let rafId: number | null = null;
  let started = false;
  let initialized = false;
  let stopped = false;
  let framesDrawn = 0;
  let startMs = 0;
  let wadCursor = 0;
  let wadFdOpen = false;
  const keyQueue: Array<{ pressed: number; key: number }> = [];
  // Buffered stdout/stderr — flushed at newlines so onLog gets coherent lines.
  const stdioBuf = ["", ""] as [string, string];

  // ── Canvas setup ──────────────────────────────────────────────────────
  canvas.width  = DG_RESX;
  canvas.height = DG_RESY;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("doom-harness: 2d canvas context unavailable");
  const imageData = ctx.createImageData(DG_RESX, DG_RESY);
  const imageU32 = new Uint32Array(imageData.data.buffer);

  // ── Memory view helper ────────────────────────────────────────────────
  // memory.grow detaches the ArrayBuffer, so re-derive views on each call.
  const mem = () => {
    const buf = (instance!.exports.memory as WebAssembly.Memory).buffer;
    return {
      u8:   new Uint8Array(buf),
      view: new DataView(buf),
    };
  };

  // ── env imports ───────────────────────────────────────────────────────
  function env_draw_frame(fb_ptr: number, w: number, h: number) {
    // doomgeneric's DG_ScreenBuffer is a uint32 framebuffer. The byte
    // order convention in doomgeneric: each pixel is 0x00RRGGBB (little-
    // endian as 4 bytes: BB, GG, RR, 00). ImageData wants RGBA bytes
    // (R G B A) — which is uint32 0xAABBGGRR little-endian. So per
    // pixel: read uint32, extract R/G/B, repack as RGBA.
    const m = mem();
    const src = new Uint32Array(m.u8.buffer, fb_ptr, w * h);
    for (let i = 0; i < w * h; i++) {
      const px = src[i];
      const r = (px >> 16) & 0xff;
      const g = (px >>  8) & 0xff;
      const b =  px        & 0xff;
      imageU32[i] = 0xff000000 | (b << 16) | (g << 8) | r;
    }
    ctx!.putImageData(imageData, 0, 0);
    framesDrawn++;
  }

  function env_get_ticks_ms(): number {
    return ((performance.now() - startMs) | 0);
  }

  function env_sleep_ms(_ms: number) {
    // RAF paces us — sleeping inside the host loop would block. No-op.
  }

  function env_get_key(pressed_ptr: number, key_ptr: number): number {
    if (keyQueue.length === 0) return 0;
    const k = keyQueue.shift()!;
    const m = mem();
    m.view.setInt32(pressed_ptr, k.pressed, true);
    m.u8[key_ptr] = k.key;
    return 1;
  }

  function env_set_window_title(title_ptr: number) {
    const m = mem();
    let end = title_ptr;
    while (m.u8[end] !== 0) end++;
    document.title = new TextDecoder().decode(m.u8.subarray(title_ptr, end));
  }

  // ── stdio buffering ───────────────────────────────────────────────────
  function emitStdio(which: 0 | 1, chunk: string) {
    const buf = stdioBuf[which] + chunk;
    const parts = buf.split("\n");
    stdioBuf[which] = parts.pop() ?? "";
    for (const line of parts) onLog(line);
  }

  // ── WASI shim ─────────────────────────────────────────────────────────
  function fd_close(fd: number): number {
    if (fd === FD_WAD) {
      wadFdOpen = false;
      wadCursor = 0;
    }
    return E_SUCCESS;
  }

  function fd_fdstat_get(fd: number, buf: number): number {
    // __wasi_fdstat_t { u8 fs_filetype; u8 pad; u16 fs_flags; u32 pad;
    //   u64 fs_rights_base; u64 fs_rights_inheriting; }  — 24 bytes
    if (fd === FD_STDIN || fd === FD_STDOUT || fd === FD_STDERR) {
      const m = mem();
      m.view.setUint8(buf, FILETYPE_REGULAR_FILE); // pretend stdio is a regular file
      m.view.setUint16(buf + 2, 0, true);
      m.view.setBigUint64(buf + 8,  0xffffffffffffffffn, true);
      m.view.setBigUint64(buf + 16, 0xffffffffffffffffn, true);
      return E_SUCCESS;
    }
    if (fd === FD_PREOPEN_ROOT) {
      const m = mem();
      m.view.setUint8(buf, FILETYPE_DIRECTORY);
      m.view.setUint16(buf + 2, 0, true);
      m.view.setBigUint64(buf + 8,  0xffffffffffffffffn, true);
      m.view.setBigUint64(buf + 16, 0xffffffffffffffffn, true);
      return E_SUCCESS;
    }
    if (fd === FD_WAD && wadFdOpen) {
      const m = mem();
      m.view.setUint8(buf, FILETYPE_REGULAR_FILE);
      m.view.setUint16(buf + 2, 0, true);
      m.view.setBigUint64(buf + 8,  0xffffffffffffffffn, true);
      m.view.setBigUint64(buf + 16, 0xffffffffffffffffn, true);
      return E_SUCCESS;
    }
    return E_BADF;
  }

  function fd_fdstat_set_flags(_fd: number, _flags: number): number {
    return E_SUCCESS;
  }

  function fd_prestat_get(fd: number, buf: number): number {
    // libc enumerates fds starting at 3 to find preopens. Return SUCCESS
    // only for fd 3 (our root); BADF for everything else ends the loop.
    if (fd !== FD_PREOPEN_ROOT) return E_BADF;
    const m = mem();
    // __wasi_prestat_t { u8 tag; u8 pad[3]; u32 dir.pr_name_len } = 8 bytes
    m.view.setUint8(buf, PREOPENTYPE_DIR);
    m.view.setUint32(buf + 4, 1, true); // "/" is 1 byte
    return E_SUCCESS;
  }

  function fd_prestat_dir_name(fd: number, path_ptr: number, path_len: number): number {
    if (fd !== FD_PREOPEN_ROOT) return E_BADF;
    if (path_len < 1) return E_INVAL;
    const m = mem();
    m.u8[path_ptr] = 0x2f; // '/'
    return E_SUCCESS;
  }

  function fd_read(fd: number, iovs_ptr: number, iovs_len: number, nread_ptr: number): number {
    const m = mem();
    if (fd === FD_STDIN) {
      m.view.setUint32(nread_ptr, 0, true);
      return E_SUCCESS;
    }
    if (fd !== FD_WAD || !wadFdOpen) return E_BADF;
    let total = 0;
    for (let i = 0; i < iovs_len; i++) {
      const ent = iovs_ptr + i * 8;
      const buf = m.view.getUint32(ent, true);
      const len = m.view.getUint32(ent + 4, true);
      const avail = wadBytes.length - wadCursor;
      const n = Math.min(len, Math.max(0, avail));
      if (n > 0) {
        m.u8.set(wadBytes.subarray(wadCursor, wadCursor + n), buf);
        wadCursor += n;
        total += n;
      }
      if (n < len) break; // EOF in this iov
    }
    m.view.setUint32(nread_ptr, total, true);
    return E_SUCCESS;
  }

  function fd_seek(fd: number, offset: bigint, whence: number, newoff_ptr: number): number {
    if (fd !== FD_WAD || !wadFdOpen) return E_BADF;
    let next: number;
    const off = Number(offset); // WAD < 2 GB; safe as Number
    if (whence === 0)      next = off;                       // SET
    else if (whence === 1) next = wadCursor + off;            // CUR
    else if (whence === 2) next = wadBytes.length + off;      // END
    else return E_INVAL;
    if (next < 0) return E_INVAL;
    wadCursor = next;
    const m = mem();
    m.view.setBigUint64(newoff_ptr, BigInt(wadCursor), true);
    return E_SUCCESS;
  }

  function fd_write(fd: number, iovs_ptr: number, iovs_len: number, nwritten_ptr: number): number {
    if (fd !== FD_STDOUT && fd !== FD_STDERR) {
      const m = mem();
      m.view.setUint32(nwritten_ptr, 0, true);
      return E_SUCCESS;
    }
    const m = mem();
    let total = 0;
    let str = "";
    for (let i = 0; i < iovs_len; i++) {
      const ent = iovs_ptr + i * 8;
      const buf = m.view.getUint32(ent, true);
      const len = m.view.getUint32(ent + 4, true);
      str += new TextDecoder().decode(m.u8.subarray(buf, buf + len));
      total += len;
    }
    m.view.setUint32(nwritten_ptr, total, true);
    if (str) emitStdio(fd === FD_STDOUT ? 0 : 1, str);
    return E_SUCCESS;
  }

  function path_open(
    _dirfd: number, _dirflags: number,
    path_ptr: number, path_len: number,
    _oflags: number, _rb: bigint, _ri: bigint, _fdflags: number,
    fd_out_ptr: number,
  ): number {
    const m = mem();
    const path = new TextDecoder().decode(m.u8.subarray(path_ptr, path_ptr + path_len));
    const base = path.split(/[\\/]/).pop()!;
    if (!matchesWad(base, wadName)) {
      // Not the WAD we have: report missing so doom keeps scanning. It
      // will eventually hit the user's actual filename and identify the
      // game correctly.
      return E_NOENT;
    }
    if (wadFdOpen) return E_INVAL; // we only support one WAD open at a time
    wadFdOpen = true;
    wadCursor = 0;
    m.view.setUint32(fd_out_ptr, FD_WAD, true);
    return E_SUCCESS;
  }

  const path_no_mutation = (..._args: unknown[]) => E_NOSYS;

  function proc_exit(code: number): never {
    stopped = true;
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    onExit(code);
    throw new Error(`proc_exit(${code})`);
  }

  // ── env.snd_* (5) — doom audio dispatch ────────────────────────────────
  // doomgeneric's plastron sound backend (in wasm-factory) forwards
  // sound_module_t calls here. We parse doom's DMX SFX header, convert
  // 8-bit unsigned PCM → Float32, and hand off to the user-supplied
  // playPcm/stopPcm/etc. callbacks (typically wired to the sound segment).
  //
  // DMX header layout (the chocolate-doom convention):
  //   bytes  0..1  uint16  format  (=3 for digital PCM; bail otherwise)
  //   bytes  2..3  uint16  sample rate (typically 11025)
  //   bytes  4..7  uint32  number of samples
  //   bytes  8..   uint8   PCM samples (unsigned 0..255; 128 = silence)
  const _sfxByChannel = new Map<number, number>();  // doom channel → sound handle

  function env_snd_init(_use_sfx_prefix: number): number {
    return playPcm ? 1 : 0;
  }

  function env_snd_start(
    data_ptr: number, length: number,
    channel: number, vol: number, sep: number,
  ): number {
    if (!playPcm) return -1;
    if (length < 8) return -1;
    const m = mem();
    const format = m.view.getUint16(data_ptr, true);
    if (format !== 3) return -1;  // not digital PCM (PC speaker / unknown)
    const rate = m.view.getUint16(data_ptr + 2, true);
    const numSamples = m.view.getUint32(data_ptr + 4, true);
    const pcmCount = Math.min(numSamples, length - 8);
    // Copy + convert 8-bit unsigned → Float32 (-1..1).
    const samples = new Float32Array(pcmCount);
    const off = data_ptr + 8;
    for (let i = 0; i < pcmCount; i++) {
      samples[i] = (m.u8[off + i] - 128) / 128;
    }
    // Stop any source already playing on this doom channel.
    const existing = _sfxByChannel.get(channel);
    if (existing !== undefined && stopPcm) stopPcm(existing);
    // Vol 0..127 → gain 0..1.  Sep 0..254 (128=center) → pan -1..+1.
    const gain = vol / 127;
    const pan  = Math.max(-1, Math.min(1, (sep - 128) / 127));
    const handle = playPcm({ samples, rate, channel, gain, pan });
    if (handle !== 0) _sfxByChannel.set(channel, handle);
    return channel;
  }

  function env_snd_stop(channel: number): void {
    const handle = _sfxByChannel.get(channel);
    if (handle !== undefined && stopPcm) stopPcm(handle);
    _sfxByChannel.delete(channel);
  }

  function env_snd_is_playing(channel: number): number {
    const handle = _sfxByChannel.get(channel);
    if (handle === undefined || !isPcmPlaying) return 0;
    return isPcmPlaying(handle) ? 1 : 0;
  }

  function env_snd_update_params(channel: number, vol: number, sep: number): void {
    const handle = _sfxByChannel.get(channel);
    if (handle === undefined || !updatePcm) return;
    const gain = vol / 127;
    const pan  = Math.max(-1, Math.min(1, (sep - 128) / 127));
    updatePcm(handle, { gain, pan });
  }

  // ── Key routing ───────────────────────────────────────────────────────
  // doomgeneric's doomkeys.h. KEY_USE/FIRE/STRAFE_* are symbolic codes in
  // the 0xa0..0xaf range — doom's default key_use binding looks for 0xa2,
  // NOT the literal ASCII 0x20 (space). Mapping spacebar to 0x20 sends
  // doom the space character, which it ignores in-game — that's why
  // pressing space wasn't opening doors. Use the symbolic codes.
  const KEY_RIGHTARROW = 0xae;
  const KEY_LEFTARROW  = 0xac;
  const KEY_UPARROW    = 0xad;
  const KEY_DOWNARROW  = 0xaf;
  const KEY_STRAFE_L   = 0xa0;
  const KEY_STRAFE_R   = 0xa1;
  const KEY_USE        = 0xa2;   // doom symbolic — what key_use defaults to
  const KEY_FIRE       = 0xa3;   // doom symbolic — what key_fire defaults to
  const KEY_ENTER      = 13;
  const KEY_ESCAPE     = 27;
  const KEY_TAB        = 9;
  const KEY_RSHIFT     = 0xb6;
  const KEY_RALT       = 0xb8;

  const map: Record<string, number> = {
    ArrowUp: KEY_UPARROW, ArrowDown: KEY_DOWNARROW,
    ArrowLeft: KEY_LEFTARROW, ArrowRight: KEY_RIGHTARROW,
    Enter: KEY_ENTER, Escape: KEY_ESCAPE,
    Tab: KEY_TAB,
    " ": KEY_USE, Space: KEY_USE,           // spacebar → open doors / use
    Control: KEY_FIRE, ControlLeft: KEY_FIRE, ControlRight: KEY_FIRE,
    Shift: KEY_RSHIFT, ShiftLeft: KEY_RSHIFT, ShiftRight: KEY_RSHIFT,
    Alt: KEY_RALT, AltLeft: KEY_RALT, AltRight: KEY_RALT,
    // Strafe — both `,`/`.` (doomgeneric's defaults) and Q/E (modern WASD).
    ",": KEY_STRAFE_L, ".": KEY_STRAFE_R,
    q: KEY_STRAFE_L,  e: KEY_STRAFE_R,
  };
  for (const c of "abcdefghijklmnopqrstuvwxyz0123456789") {
    if (!(c in map)) map[c] = c.charCodeAt(0);
  }
  let keyListenersAttached = false;
  function onKey(pressed: number, e: KeyboardEvent) {
    if (e.repeat) return;
    const key = map[e.key] ?? map[e.code] ?? null;
    if (key !== null) {
      keyQueue.push({ pressed, key });
      // Swallow arrows etc. so the page doesn't scroll.
      if (e.key.startsWith("Arrow") || e.key === " " || e.key === "Tab") {
        e.preventDefault();
      }
    }
  }
  const keydownHandler = (e: KeyboardEvent) => onKey(1, e);
  const keyupHandler   = (e: KeyboardEvent) => onKey(0, e);

  // ── Provider envelope ─────────────────────────────────────────────────
  function provider(): ImportsEnvelope {
    return {
      imports: {
        env: {
          draw_frame:        env_draw_frame        as (...a: unknown[]) => unknown,
          get_ticks_ms:      env_get_ticks_ms      as (...a: unknown[]) => unknown,
          sleep_ms:          env_sleep_ms          as (...a: unknown[]) => unknown,
          get_key:           env_get_key           as (...a: unknown[]) => unknown,
          set_window_title:  env_set_window_title  as (...a: unknown[]) => unknown,
          snd_init:          env_snd_init          as (...a: unknown[]) => unknown,
          snd_start:         env_snd_start         as (...a: unknown[]) => unknown,
          snd_stop:          env_snd_stop          as (...a: unknown[]) => unknown,
          snd_is_playing:    env_snd_is_playing    as (...a: unknown[]) => unknown,
          snd_update_params: env_snd_update_params as (...a: unknown[]) => unknown,
        },
        wasi_snapshot_preview1: {
          fd_close, fd_fdstat_get, fd_fdstat_set_flags,
          fd_prestat_get, fd_prestat_dir_name,
          fd_read, fd_seek, fd_write,
          path_create_directory: path_no_mutation,
          path_open,
          path_remove_directory: path_no_mutation,
          path_rename:           path_no_mutation,
          path_unlink_file:      path_no_mutation,
          proc_exit,
        } as Record<string, (...a: unknown[]) => unknown>,
      },
      onInstantiate: (inst) => {
        instance = inst;
        startMs = performance.now();
      },
      dispose: () => {
        stopped = true;
        if (rafId !== null) cancelAnimationFrame(rafId);
        if (keyListenersAttached) {
          window.removeEventListener("keydown", keydownHandler);
          window.removeEventListener("keyup",   keyupHandler);
          keyListenersAttached = false;
        }
      },
    };
  }

  // ── Lifecycle: ignite the engine ───────────────────────────────────────
  function start() {
    if (started) return;
    if (!instance) throw new Error("doom-harness: instance not captured — call start() AFTER hydrate");
    started = true;
    // wasi-libc reactor model: host calls _initialize first to run ctors.
    (instance.exports._initialize as () => void)();
    initialized = true;
    onLog("✓ _initialize ran");
    // argc=0, argv=NULL — doomgeneric handles it (M_FindResponseFile
    // loops to argc, M_CheckParm returns 0 on miss).
    try {
      (instance.exports.doomgeneric_Create as (argc: number, argv: number) => void)(0, 0);
    } catch (e) {
      onLog("× doomgeneric_Create threw: " + (e as Error).message);
      throw e;
    }
    onLog("✓ doomgeneric_Create returned");

    window.addEventListener("keydown", keydownHandler);
    window.addEventListener("keyup",   keyupHandler);
    keyListenersAttached = true;

    const tick = () => {
      if (stopped) return;
      try {
        (instance!.exports.doomgeneric_Tick as () => void)();
      } catch (e) {
        onLog("× doomgeneric_Tick threw: " + (e as Error).message);
        stopped = true;
        return;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    stopped = true;
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function state() {
    return { initialized, started, stopped, framesDrawn, wadCursor };
  }

  return { provider, start, stop, state };
}
