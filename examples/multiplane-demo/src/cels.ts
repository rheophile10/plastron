import type {
  Fn, LambdaKey, Segment, State,
} from "../../../plastron/src/index.js";
import type { Camera, Layer, Scene } from "../../../segments/plastron-multiplane/src/index.js";
import {
  PALETTES, buildLayers, type Palette, type PaletteKey, type LayerCanvases,
} from "./art.js";

// ============================================================================
// Multiplane demo cel graph.
//
// Value cels (writable):
//
//   frame            number   current animation time in ms; rAF loop writes
//                             performance.now() into this when playing.
//   scrubFrame       number?  override frame when the user scrubs; null
//                             when auto-pan is in control.
//   playing          boolean  rAF loop only writes frame when true.
//   lighting         "dawn"|"noon"|"evening"|"night"  active palette key.
//
// Lambda cels (computed):
//
//   effectiveFrame   number          scrubFrame ?? frame
//   palette          Palette         PALETTES[lighting]
//   layers           LayerCanvases   rebuilds offscreen canvases when
//                                    palette changes (heavy-but-cheap;
//                                    ~few ms per rebuild).
//   camera           Camera          slow sine-wave pan + bob driven by
//                                    effectiveFrame.
//   scene            Scene           composes layers + camera into the
//                                    Scene that plastron-canvas paints.
//
// Action lambdas (referenced from UI dispatch):
//
//   demo:setLighting    payload = PaletteKey   writes lighting.
//   demo:togglePlaying  flips playing.
//   demo:resetScrub     sets scrubFrame to null (releases user override).
// ============================================================================

export const SCENE_W = 800;
export const SCENE_H = 500;

// Offscreen-canvas dimensions for the painted layers. Larger than the
// scene's visible area so parallax-induced offsets never reveal a layer's
// edge. The renderer scales each draw call by perspZ; effective on-screen
// size = LAYER_W × perspZ.
const LAYER_W = 1400;
const LAYER_H = 900;

// ── Lambdas ─────────────────────────────────────────────────────────────────

interface EffectiveFrameInputs { frame: number; scrubFrame: number | null }
const effectiveFrame: Fn = ({ frame, scrubFrame }: EffectiveFrameInputs): number =>
  scrubFrame !== null && scrubFrame !== undefined ? scrubFrame : frame;

interface PaletteInputs { lighting: PaletteKey }
const palette: Fn = ({ lighting }: PaletteInputs): Palette =>
  PALETTES[lighting] ?? PALETTES.noon;

interface LayersInputs { palette: Palette }
const layers: Fn = ({ palette }: LayersInputs): LayerCanvases =>
  buildLayers(LAYER_W, LAYER_H, palette);

interface CameraInputs { effectiveFrame: number }
const camera: Fn = ({ effectiveFrame }: CameraInputs): Camera => {
  // Time in seconds. Slow figure-eight: pan ±80 horizontally, ±12 vertically.
  const t = effectiveFrame / 1000;
  return {
    x: Math.sin(t * 0.35) * 80,
    y: Math.sin(t * 0.55) * 12,
    z: 0,
    focal: 800,
  };
};

interface SceneInputs {
  layers: LayerCanvases;
  camera: Camera;
  effectiveFrame: number;
}
const scene: Fn = ({ layers, camera, effectiveFrame }: SceneInputs): Scene => {
  // Compose four layers, z DESCENDING (back-to-front per painter's algo).
  // All four drawings sit at world-origin (0, 0); the camera moves the
  // world, layers parallax by z.
  const mkLayer = (z: number, img: HTMLCanvasElement): Layer => ({
    z,
    opacity: 1,
    visible: true,
    gen: 0,
    drawings: [{
      lineArt: img,
      x: 0, y: 0, z: 0,
      gen: 0,
    }],
  });
  return {
    layers: [
      mkLayer(80, layers.sky),
      mkLayer(40, layers.mountains),
      mkLayer(15, layers.hills),
      mkLayer( 2, layers.branches),
    ],
    camera,
    frame: effectiveFrame,
    width: SCENE_W,
    height: SCENE_H,
    gen: 0,
  };
};

// ── Action lambdas ──────────────────────────────────────────────────────────

const setLighting: Fn = async (...args: unknown[]) => {
  const [state, payload] = args as [State, PaletteKey];
  if (!payload || !(payload in PALETTES)) return;
  await (state.fns.get("set") as Fn)(state, "lighting", payload);
};

const togglePlaying: Fn = async (...args: unknown[]) => {
  const [state] = args as [State];
  const cur = !!state.cels.get("playing")?.v;
  await (state.fns.get("set") as Fn)(state, "playing", !cur);
};

const resetScrub: Fn = async (...args: unknown[]) => {
  const [state] = args as [State];
  await (state.fns.get("set") as Fn)(state, "scrubFrame", null);
};

// ── Segment + fn map ────────────────────────────────────────────────────────

export const DEMO_SEGMENT = "multiplane-demo" as const;

export const demoSegment: Segment = {
  key: DEMO_SEGMENT,
  cels: [
    // Source cels.
    { key: "frame",       v: 0,      segment: DEMO_SEGMENT },
    { key: "scrubFrame",  v: null,   segment: DEMO_SEGMENT },
    { key: "playing",     v: true,   segment: DEMO_SEGMENT },
    { key: "lighting",    v: "noon" as PaletteKey, segment: DEMO_SEGMENT },

    // Derived: effective frame combines auto-pan + scrub.
    {
      key: "effectiveFrame",
      segment: DEMO_SEGMENT,
      l: "effectiveFrame",
      inputMap: { frame: "frame", scrubFrame: "scrubFrame" },
    },

    // Lighting → palette → offscreen-canvas art.
    {
      key: "palette",
      segment: DEMO_SEGMENT,
      l: "palette",
      inputMap: { lighting: "lighting" },
    },
    {
      key: "layers",
      segment: DEMO_SEGMENT,
      l: "layers",
      inputMap: { palette: "palette" },
    },

    // Effective frame → camera.
    {
      key: "camera",
      segment: DEMO_SEGMENT,
      l: "camera",
      inputMap: { effectiveFrame: "effectiveFrame" },
    },

    // Layers + camera → scene. This is the cel installCanvas paints.
    {
      key: "scene",
      segment: DEMO_SEGMENT,
      l: "scene",
      inputMap: {
        layers: "layers",
        camera: "camera",
        effectiveFrame: "effectiveFrame",
      },
    },
  ],
  fnMetaData: {
    effectiveFrame:        { key: "effectiveFrame",        kind: "native" },
    palette:               { key: "palette",               kind: "native" },
    layers:                { key: "layers",                kind: "native" },
    camera:                { key: "camera",                kind: "native" },
    scene:                 { key: "scene",                 kind: "native" },
    "demo:setLighting":    { key: "demo:setLighting",      kind: "native" },
    "demo:togglePlaying":  { key: "demo:togglePlaying",    kind: "native" },
    "demo:resetScrub":     { key: "demo:resetScrub",       kind: "native" },
  },
};

export const demoFns: Map<LambdaKey, Fn> = new Map<LambdaKey, Fn>([
  ["effectiveFrame",       effectiveFrame],
  ["palette",              palette],
  ["layers",               layers],
  ["camera",               camera],
  ["scene",                scene],
  ["demo:setLighting",     setLighting],
  ["demo:togglePlaying",   togglePlaying],
  ["demo:resetScrub",      resetScrub],
]);
