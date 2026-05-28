import type { 甲骨, Cel, Fn, State } from "../types/index.js";
import { bindNativeFns } from "./nativeFn.js";
import seed from "./sound.json" with { type: "json" };

// ============================================================================
// sound — Web Audio capability segment. Plays synthesized tones or raw
// PCM via the browser's AudioContext. Browser-only; off-browser every
// fn is a no-op so app code that uses it is portable (the off-browser
// behavior is silent, never an error).
//
// Lazy AudioContext init: browsers gate context creation behind a user
// gesture (click/keydown). We construct on first play call — if it's
// the result of a user gesture the context starts in "running"; otherwise
// in "suspended" until the user interacts.
//
// Module-scoped runtime state (the AudioContext + active source set) is
// SHARED across all States in the process. That's fine here — there's
// only ever one audio output per browser tab — and it matches how
// `host.now` / file-store's backend behave (module singletons).
// ============================================================================

// Web Audio types — declared structurally so we don't need DOM lib.
// (mirrors how wat-compiler / csp / file-store reach for WebAssembly /
//  navigator / process without pulling in browser/node type packages.)
interface AudioParamLike {
  value: number;
  setValueAtTime: (v: number, t: number) => void;
  linearRampToValueAtTime: (v: number, t: number) => void;
}
interface AudioNodeLike { connect: (dst: AudioNodeLike) => AudioNodeLike; }
interface OscillatorLike extends AudioNodeLike {
  type: "sine" | "square" | "sawtooth" | "triangle";
  frequency: AudioParamLike;
  start: (t: number) => void;
  stop: (t?: number) => void;
  onended: (() => void) | null;
}
interface GainLike   extends AudioNodeLike { gain: AudioParamLike; }
interface PannerLike extends AudioNodeLike { pan:  AudioParamLike; }
interface AudioBufferLike { copyToChannel: (src: Float32Array, ch: number) => void; }
interface BufferSourceLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  start: (t?: number) => void;
  stop: (t?: number) => void;
  onended: (() => void) | null;
}
interface AudioCtxLike {
  state: string;
  currentTime: number;
  destination: AudioNodeLike;
  createOscillator: () => OscillatorLike;
  createGain: () => GainLike;
  createStereoPanner?: () => PannerLike;
  createBuffer: (channels: number, length: number, rate: number) => AudioBufferLike;
  createBufferSource: () => BufferSourceLike;
  resume?: () => Promise<void>;
}
interface AudioCtxCtor { new(opts?: object): AudioCtxLike; }

const _AudioCtxCtor: AudioCtxCtor | undefined =
  (globalThis as { AudioContext?: AudioCtxCtor; webkitAudioContext?: AudioCtxCtor })
    .AudioContext
  ?? (globalThis as { webkitAudioContext?: AudioCtxCtor }).webkitAudioContext;

let _ctx: AudioCtxLike | null = null;
const _activeSources = new Set<{ stop: () => void }>();

// Handle table for play-pcm: handle (number) → live source + its gain
// and panner nodes (so update-source can change them after start).
interface SourceEntry {
  node:   BufferSourceLike;
  gain:   GainLike;
  panner: PannerLike | null;
  ended:  boolean;
}
const _sources = new Map<number, SourceEntry>();
let _nextHandle = 1;

const ensureCtx = (): AudioCtxLike | null => {
  if (!_AudioCtxCtor) return null;
  if (!_ctx) _ctx = new _AudioCtxCtor();
  // Resume if suspended (browsers can re-suspend after tab background).
  if (_ctx.state === "suspended" && _ctx.resume) {
    void _ctx.resume();
  }
  return _ctx;
};

const updateContextState = (state: State): void => {
  const cel = state.cels.get("sound.context-state");
  if (cel) cel.v = _ctx ? _ctx.state : "absent";
};

const readMaster = (state: State): number => {
  const v = state.cels.get("sound.master-gain")?.v;
  return typeof v === "number" ? v : 1;
};

// ── play-tone ───────────────────────────────────────────────────────────────

const playTone: Fn = (state: State, args: unknown = {}) => {
  const ctx = ensureCtx();
  if (!ctx) { updateContextState(state); return; }
  const a = (args ?? {}) as {
    freq?: number; duration?: number;
    type?: "sine" | "square" | "sawtooth" | "triangle"; gain?: number;
  };
  const freq     = a.freq     ?? 440;
  const duration = (a.duration ?? 200) / 1000;
  const type     = a.type     ?? "sine";
  const gain     = (a.gain    ?? 0.3) * readMaster(state);

  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const g = ctx.createGain();
  // 5ms attack + linear decay envelope — keeps starts and ends click-free.
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(gain, now + 0.005);
  g.gain.linearRampToValueAtTime(0,    now + duration);
  osc.connect(g).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + duration);
  _activeSources.add(osc);
  osc.onended = () => { _activeSources.delete(osc); };

  updateContextState(state);
};

// ── play-pcm ────────────────────────────────────────────────────────────────

const playPcm: Fn = (state: State, args: unknown = {}): number => {
  // Validate inputs *before* the off-browser early-return — contract
  // shape is a static promise, not a runtime resource concern.
  const a = (args ?? {}) as {
    samples?: Float32Array; rate?: number; channels?: number;
    gain?: number; pan?: number;
  };
  if (!(a.samples instanceof Float32Array)) {
    throw new Error(`sound.play-pcm: samples must be a Float32Array (got ${typeof a.samples})`);
  }
  const ctx = ensureCtx();
  if (!ctx) { updateContextState(state); return 0; }   // 0 = invalid handle
  const rate     = a.rate     ?? 44100;
  const channels = a.channels ?? 1;
  const gain     = (a.gain    ?? 1) * readMaster(state);
  const pan      = Math.max(-1, Math.min(1, a.pan ?? 0));

  const frames = a.samples.length / channels;
  const buf = ctx.createBuffer(channels, frames, rate);
  if (channels === 1) {
    buf.copyToChannel(a.samples, 0);
  } else {
    for (let ch = 0; ch < channels; ch++) {
      const chData = new Float32Array(frames);
      for (let i = 0; i < frames; i++) chData[i] = a.samples[i * channels + ch];
      buf.copyToChannel(chData, ch);
    }
  }

  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = gain;
  // Always insert a panner when the browser ships it, so update-source
  // can change pan after start. Older browsers without StereoPannerNode
  // get a mono path (gain-only) — they still play, just no panning.
  const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (panner) panner.pan.value = pan;
  src.connect(g);
  if (panner) {
    g.connect(panner);
    panner.connect(ctx.destination);
  } else {
    g.connect(ctx.destination);
  }
  src.start();

  const handle = _nextHandle++;
  const entry: SourceEntry = { node: src, gain: g, panner, ended: false };
  _sources.set(handle, entry);
  _activeSources.add(src);
  src.onended = () => {
    entry.ended = true;
    _activeSources.delete(src);
    _sources.delete(handle);
  };

  updateContextState(state);
  return handle;
};

// ── stop-all ────────────────────────────────────────────────────────────────

const stopAll: Fn = (state: State) => {
  for (const src of _activeSources) {
    try { src.stop(); } catch { /* may already have stopped */ }
  }
  _activeSources.clear();
  _sources.clear();
  updateContextState(state);
};

// ── handle-based fns (per-source control for stop / update-params / poll) ──

const stopSource: Fn = (_state: State, handle: unknown) => {
  if (typeof handle !== "number") return;
  const e = _sources.get(handle);
  if (!e) return;
  try { e.node.stop(); } catch { /* ignore */ }
  _activeSources.delete(e.node);
  _sources.delete(handle);
};

const updateSource: Fn = (state: State, handle: unknown, args: unknown = {}) => {
  if (typeof handle !== "number") return;
  const e = _sources.get(handle);
  if (!e) return;
  const a = (args ?? {}) as { gain?: number; pan?: number };
  if (typeof a.gain === "number") {
    e.gain.gain.value = a.gain * readMaster(state);
  }
  if (typeof a.pan === "number" && e.panner) {
    e.panner.pan.value = Math.max(-1, Math.min(1, a.pan));
  }
};

const isPlaying: Fn = (_state: State, handle: unknown): boolean => {
  if (typeof handle !== "number") return false;
  const e = _sources.get(handle);
  return !!e && !e.ended;
};

// ── Segment export ──────────────────────────────────────────────────────────

export const name = "sound" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["sound.play-tone",     playTone],
  ["sound.play-pcm",      playPcm],
  ["sound.stop-all",      stopAll],
  ["sound.stop-source",   stopSource],
  ["sound.update-source", updateSource],
  ["sound.is-playing",    isPlaying],
]));

// Test-only: reset module state between Bun test files / fresh States that
// want a clean audio graph. Production code never calls this.
export const _resetSoundForTests = (): void => {
  for (const src of _activeSources) {
    try { src.stop(); } catch { /* ignore */ }
  }
  _activeSources.clear();
  _sources.clear();
  _nextHandle = 1;
  _ctx = null;
};
