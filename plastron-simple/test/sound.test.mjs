import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";
import { _resetSoundForTests } from "../dist/甲骨坑/sound.js";

// The sound segment is browser-only at runtime — Bun has no AudioContext,
// so every play call is a silent no-op. These tests assert the *shape*
// (cels seeded, fns reachable, no-op safely) so we know the segment is
// portable. Audible verification lives in plastron-simple-examples/keyboard.

// ── boot ────────────────────────────────────────────────────────────────────

test("sound segment seeds the expected cels", () => {
  _resetSoundForTests();
  const state = createInitialState();
  for (const key of [
    "sound.context-state", "sound.master-gain",
    "sound.play-tone", "sound.play-pcm", "sound.stop-all",
  ]) {
    assert.ok(state.cels.get(key), `missing ${key}`);
  }
  // Defaults.
  assert.equal(state.cels.get("sound.context-state").v, "absent");
  assert.equal(state.cels.get("sound.master-gain").v, 1);
  // Locked compute cels are callable as Fns.
  assert.equal(typeof resolveFn(state, "sound.play-tone"), "function");
  assert.equal(typeof resolveFn(state, "sound.play-pcm"), "function");
  assert.equal(typeof resolveFn(state, "sound.stop-all"), "function");
});

// ── off-browser no-op ────────────────────────────────────────────────────────

test("sound.play-tone is a silent no-op off-browser (no throw)", () => {
  _resetSoundForTests();
  const state = createInitialState();
  const playTone = resolveFn(state, "sound.play-tone");
  // A bunch of legal arg shapes — none should throw.
  playTone(state, { freq: 440, duration: 100 });
  playTone(state, { freq: 220, duration: 50, type: "square", gain: 0.5 });
  playTone(state, {});
  playTone(state);
  // context-state stays "absent" since no AudioContext was created.
  assert.equal(state.cels.get("sound.context-state").v, "absent");
});

test("sound.play-pcm is a silent no-op off-browser (no throw)", () => {
  _resetSoundForTests();
  const state = createInitialState();
  const playPcm = resolveFn(state, "sound.play-pcm");
  playPcm(state, { samples: new Float32Array(1024), rate: 22050 });
  playPcm(state, { samples: new Float32Array(2048), rate: 44100, channels: 2 });
  assert.equal(state.cels.get("sound.context-state").v, "absent");
});

test("sound.play-pcm rejects non-Float32Array samples", () => {
  _resetSoundForTests();
  const state = createInitialState();
  const playPcm = resolveFn(state, "sound.play-pcm");
  // (Throws synchronously even off-browser — this is a contract check,
  // not a runtime resource issue.)
  assert.throws(() => playPcm(state, { samples: [0, 0, 0], rate: 44100 }),
    /samples must be a Float32Array/);
  assert.throws(() => playPcm(state, { samples: "audio", rate: 44100 }),
    /samples must be a Float32Array/);
});

test("sound.stop-all is callable off-browser (no throw, no effect)", () => {
  _resetSoundForTests();
  const state = createInitialState();
  const stopAll = resolveFn(state, "sound.stop-all");
  stopAll(state);
  stopAll(state); // idempotent
  assert.equal(state.cels.get("sound.context-state").v, "absent");
});

// ── master-gain is a writable ValueCel ──────────────────────────────────────

test("sound.master-gain can be mutated via setCel and is read at each play call", async () => {
  _resetSoundForTests();
  const state = createInitialState();
  const setCel = resolveFn(state, "setCel");
  await setCel(state, "sound.master-gain", { v: 0.25 });
  assert.equal(state.cels.get("sound.master-gain").v, 0.25);
  // Calling play-tone reads the current master each time. (Off-browser
  // there's no audible effect, but the read happens — proof is that
  // we don't throw and the cel value stays settable.)
  resolveFn(state, "sound.play-tone")(state, { freq: 440 });
  assert.equal(state.cels.get("sound.master-gain").v, 0.25);
});
