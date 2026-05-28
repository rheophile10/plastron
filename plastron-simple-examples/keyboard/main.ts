// keyboard — a musical keyboard demo for the `sound` segment.
//
// One QWERTY-key-per-note mapping. Pressing a key calls
// `sound.play-tone` through plastron's resolveFn. Visual piano keys
// are also clickable. Waveform / volume / octave-shift controls are
// kernel-segment ValueCels we set via `sound.master-gain` (volume) and
// local state (waveform + octave).
//
// Same `sound` segment the doom example uses (it routes
// doomgeneric_Tick's SFX through `sound.play-pcm`).

import {
  createInitialState, resolveFn,
} from "../../plastron-simple/src/index.js";
import type { Fn } from "../../plastron-simple/src/index.js";

const state = createInitialState();
const playTone = resolveFn(state, "sound.play-tone") as Fn;
const setCel   = resolveFn(state, "setCel") as Fn;

// ── note → frequency ────────────────────────────────────────────────────────
// Frequencies are for octave 4; we shift by powers of 2 for other octaves.
// Order matters here — left to right on the piano.
interface KeyDef {
  key: string;       // KeyboardEvent.key (lowercase)
  note: string;      // display name
  semitoneFromC: number; // 0..n; we compute freq from this
  black: boolean;
  whiteIdx?: number; // for white keys: position in white-keys row
  blackBetween?: number; // for black keys: between which two white indices
}

// Two octaves' worth — one full + the start of the next. White keys laid
// out left→right; black keys positioned absolutely between them.
const KEYS: KeyDef[] = [
  // octave A: white "a s d f g h j" + black "w e   t y u"
  { key: "a", note: "C",  semitoneFromC: 0,  black: false, whiteIdx: 0 },
  { key: "w", note: "C#", semitoneFromC: 1,  black: true,  blackBetween: 0 },
  { key: "s", note: "D",  semitoneFromC: 2,  black: false, whiteIdx: 1 },
  { key: "e", note: "D#", semitoneFromC: 3,  black: true,  blackBetween: 1 },
  { key: "d", note: "E",  semitoneFromC: 4,  black: false, whiteIdx: 2 },
  { key: "f", note: "F",  semitoneFromC: 5,  black: false, whiteIdx: 3 },
  { key: "t", note: "F#", semitoneFromC: 6,  black: true,  blackBetween: 3 },
  { key: "g", note: "G",  semitoneFromC: 7,  black: false, whiteIdx: 4 },
  { key: "y", note: "G#", semitoneFromC: 8,  black: true,  blackBetween: 4 },
  { key: "h", note: "A",  semitoneFromC: 9,  black: false, whiteIdx: 5 },
  { key: "u", note: "A#", semitoneFromC: 10, black: true,  blackBetween: 5 },
  { key: "j", note: "B",  semitoneFromC: 11, black: false, whiteIdx: 6 },
  // octave A+1
  { key: "k", note: "C",  semitoneFromC: 12, black: false, whiteIdx: 7 },
  { key: "o", note: "C#", semitoneFromC: 13, black: true,  blackBetween: 7 },
  { key: "l", note: "D",  semitoneFromC: 14, black: false, whiteIdx: 8 },
  { key: "p", note: "D#", semitoneFromC: 15, black: true,  blackBetween: 8 },
  { key: ";", note: "E",  semitoneFromC: 16, black: false, whiteIdx: 9 },
];

// ── controls ────────────────────────────────────────────────────────────────

const $ = (id: string) => document.getElementById(id)!;
const waveSel = $("wave") as HTMLSelectElement;
const volSlider = $("vol") as HTMLInputElement;
const octSlider = $("oct") as HTMLInputElement;
const volVal = $("vol-val");
const octVal = $("oct-val");
const statusEl = $("status");

const setStatus = (s: string) => { statusEl.textContent = s; };

let currentOctave = Number(octSlider.value);
let currentWave: "sine" | "square" | "sawtooth" | "triangle" =
  waveSel.value as "sine" | "square" | "sawtooth" | "triangle";

const freqFor = (semitoneFromC: number, octave: number): number => {
  // MIDI note number for the chosen C-of-octave is 12 * (octave + 1).
  // The note's MIDI = base + semitone offset.
  const midi = 12 * (octave + 1) + semitoneFromC;
  return 440 * Math.pow(2, (midi - 69) / 12);
};

waveSel.addEventListener("change", () => {
  currentWave = waveSel.value as typeof currentWave;
});

volSlider.addEventListener("input", async () => {
  const v = Number(volSlider.value) / 100;
  volVal.textContent = `${volSlider.value}%`;
  await setCel(state, "sound.master-gain", { v });
});

octSlider.addEventListener("input", () => {
  currentOctave = Number(octSlider.value);
  octVal.textContent = octSlider.value;
});

// ── piano render ────────────────────────────────────────────────────────────

const whiteKeysEl = $("white-keys");
const pianoEl = $("piano");
const whites = KEYS.filter((k) => !k.black);
const blacks = KEYS.filter((k) => k.black);

const elementByKey = new Map<string, HTMLDivElement>();

for (const k of whites) {
  const el = document.createElement("div");
  el.className = "white";
  el.dataset.key = k.key;
  const lbl = document.createElement("div");
  lbl.className = "label";
  lbl.innerHTML = `<div>${k.note}</div><div style="opacity:.6">${k.key}</div>`;
  el.appendChild(lbl);
  el.addEventListener("mousedown", () => press(k));
  whiteKeysEl.appendChild(el);
  elementByKey.set(k.key, el);
}

// Black keys: positioned at the boundary between two white keys.
for (const k of blacks) {
  const el = document.createElement("div");
  el.className = "black";
  el.dataset.key = k.key;
  // CSS: width 6% of piano. Center on the boundary between
  // blackBetween and blackBetween+1, where each white = 10% of piano width.
  const center = ((k.blackBetween! + 1) / whites.length) * 100;
  el.style.left = `calc(${center}% - 3%)`;
  const lbl = document.createElement("div");
  lbl.className = "label";
  lbl.innerHTML = `<div>${k.note}</div><div style="opacity:.6">${k.key}</div>`;
  el.appendChild(lbl);
  el.addEventListener("mousedown", () => press(k));
  pianoEl.appendChild(el);
  elementByKey.set(k.key, el);
}

// ── press / release ─────────────────────────────────────────────────────────

function press(k: KeyDef): void {
  const freq = freqFor(k.semitoneFromC, currentOctave);
  playTone(state, {
    freq,
    duration: 400,
    type: currentWave,
    gain: 0.3,
  });
  const el = elementByKey.get(k.key);
  if (el) {
    el.classList.add("pressed");
    setTimeout(() => el.classList.remove("pressed"), 200);
  }
  setStatus(`${k.note}${currentOctave + Math.floor(k.semitoneFromC / 12)} — ${freq.toFixed(2)} Hz  [${currentWave}]`);
}

// Keyboard input: keydown fires a note (we use keydown not keyup so each
// press triggers a distinct tone; repeats are suppressed via e.repeat).
document.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  const key = e.key.toLowerCase();
  const k = KEYS.find((kk) => kk.key === key);
  if (k) {
    press(k);
    e.preventDefault();
  }
});
