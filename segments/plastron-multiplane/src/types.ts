// ============================================================================
// Drawing / Layer / Scene — the three envelopes plastron-multiplane composites.
//
// The data model is a direct port of Disney's CAPS-style multiplane shape:
//
//   Scene
//   ├── camera   (x, y, z, focal length)
//   ├── frame    (current frame index — frame-indexed lookups by callers)
//   └── layers[] (z-ordered back-to-front)
//        └── drawings[]  (each drawing has its own world-space position and z)
//
// Two z-axes interact:
//
//   • Layer.z      — the multiplane "plane" the layer sits on. Drives parallax
//                    relative to the camera. Background = high z, foreground
//                    = low z. All drawings on the same layer share parallax.
//   • Drawing.z    — drawing-local depth within a layer. Lets you stack
//                    drawings inside a single z-plane without making a new
//                    Layer. Adds to Layer.z for parallax computation.
//
// `gen` counters are the change-detection signal — multiplane renders pure
// from a Scene snapshot, no diff is computed, so gen exists only so the
// kernel's gen-counter isChanged can suppress re-paints when nothing
// observable changed.
//
// Image storage: ImageBitmap. Decoded, GPU-friendly, no per-frame parsing
// cost. Cels carry references; the user owns the lifecycle (acquired via
// `createImageBitmap` or fetched/cached). Future archive-friendly storage
// is a separate concern.
// ============================================================================

export type DrawingImage = ImageBitmap | HTMLImageElement | HTMLCanvasElement;

export interface Drawing {
  /** The line-art image — scanned cel-art originally, anything `drawImage`
   *  can paint today (ImageBitmap, HTMLImageElement, HTMLCanvasElement). */
  lineArt: DrawingImage;
  /** Optional ink-and-paint fills. Region-id → CSS color string. Today
   *  the multiplane renderer doesn't apply these directly; callers paint
   *  the fills into the lineArt offscreen-canvas before passing in. Field
   *  is reserved for a future fills-composition pipeline. */
  fills?: Record<string, string>;
  /** World-space position. Camera x/y are subtracted at render time. */
  x: number;
  y: number;
  /** Within-layer depth offset. Added to Layer.z for parallax. Defaults 0. */
  z: number;
  /** Uniform scale. Defaults 1. Applied AFTER parallax scaling. */
  scale?: number;
  /** Rotation in radians, applied around the drawing's center. Defaults 0. */
  rotation?: number;
  /** 0..1. Multiplied with Layer.opacity at render time. Defaults 1. */
  opacity?: number;
  /** Optional source rect for atlas sheets. Defaults to the whole image. */
  src?: { x: number; y: number; w: number; h: number };
  /** Change-detection counter. Bumped by writers when the drawing
   *  changes. Pairs with `drawingIsChanged`. */
  gen: number;
}

export interface Layer {
  drawings: Drawing[];
  /** Multiplane z-depth. Higher = further from camera (more parallax
   *  damping). Layer.z + Drawing.z is the effective depth for parallax. */
  z: number;
  /** 0..1. Multiplied with per-drawing opacity. */
  opacity: number;
  visible: boolean;
  gen: number;
}

export interface Camera {
  /** World-space coordinates. */
  x: number;
  y: number;
  z: number;
  /** Perspective focal length. Larger = flatter parallax (camera further
   *  away). Defaults 800 in the renderer if omitted. */
  focal?: number;
  /** Camera rotation in radians, applied around the canvas center. Defaults 0. */
  rotation?: number;
}

export interface Scene {
  /** Layers sorted by z DESCENDING (back-to-front for painter's
   *  algorithm). The render lambda doesn't sort — caller is expected
   *  to maintain the invariant. Failing to sort produces incorrect
   *  occlusion. */
  layers: Layer[];
  camera: Camera;
  /** Current frame index — for frame-indexed lookups by the caller's
   *  scene-builder logic. The renderer itself doesn't read frame. */
  frame: number;
  /** Canvas-space dimensions. */
  width: number;
  height: number;
  gen: number;
}
