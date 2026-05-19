import type { Drawing, Layer, Scene } from "./types.js";

// ============================================================================
// renderMultiplane — pure paint function.
//
// Signature matches plastron-canvas's `DrawFn`: (ctx, data) => void. Host
// wires this as the draw fn on the canvas root whose source cel is a
// Scene. plastron-canvas calls it inside rAF on every cel-change.
//
// Math: standard perspective parallax. For a drawing at (x, y, z) on a
// layer at z_l, with camera at (cx, cy, cz) and focal length f:
//
//   effZ    = z_l + z - cz          (drawing depth relative to camera)
//   perspZ  = f / (f + effZ)        (perspective scale; 1 at camera plane,
//                                    < 1 behind, > 1 in front of camera plane)
//   screenX = w/2 + (x - cx) * perspZ
//   screenY = h/2 + (y - cy) * perspZ
//
// The classic multiplane camera worked this way: closer layers move
// faster than distant ones when the camera pans, producing parallax.
// The CAPS digital version preserved the shape; this is the same math
// in JS + Canvas 2D.
//
// DPR scaling: the canvas backing store is sized to CSS-pixel rect × DPR
// (plastron-canvas's resize handling). The user's Scene declares
// width/height in CSS pixels. We set a DPR scale once per frame so all
// the math below works in CSS-pixel space.
//
// Layers are NOT sorted here — caller is expected to maintain
// z-descending order. Sorting per-frame would cost O(n log n) when O(1)
// is achievable by keeping the array invariant. Documented in types.ts.
// ============================================================================

const DEFAULT_FOCAL = 800;

const safePerspZ = (focal: number, effZ: number): number => {
  // Avoid division by zero / negative perspective. effZ + focal ≤ 0 means
  // the drawing is behind the camera plane by more than the focal length —
  // mathematically off-screen. We clamp to a small positive value so the
  // drawing still renders (heavily compressed) rather than disappearing
  // or flipping. The compressed-but-visible behavior is closer to what
  // animators expected from the physical multiplane.
  const denom = focal + effZ;
  return denom > 0.001 ? focal / denom : focal / 0.001;
};

const drawDrawing = (
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  layer: Layer,
  scene: Scene,
  focal: number,
): void => {
  const effZ = layer.z + (drawing.z ?? 0) - scene.camera.z;
  const perspZ = safePerspZ(focal, effZ);

  const screenX = scene.width  / 2 + (drawing.x - scene.camera.x) * perspZ;
  const screenY = scene.height / 2 + (drawing.y - scene.camera.y) * perspZ;

  const img = drawing.lineArt;
  // ImageBitmap / HTMLImageElement / HTMLCanvasElement all expose .width
  // and .height. Cast through to avoid the discriminated-union narrowing.
  const { width: iw, height: ih } = img as { width: number; height: number };
  if (!iw || !ih) return; // unloaded / zero-sized — skip silently

  const drawScale = (drawing.scale ?? 1) * perspZ;
  const alpha = layer.opacity * (drawing.opacity ?? 1);
  if (alpha <= 0) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(screenX, screenY);
  const rot = drawing.rotation ?? 0;
  if (rot !== 0) ctx.rotate(rot);
  if (drawScale !== 1) ctx.scale(drawScale, drawScale);

  const src = drawing.src;
  if (src) {
    ctx.drawImage(
      img,
      src.x, src.y, src.w, src.h,
      -src.w / 2, -src.h / 2, src.w, src.h,
    );
  } else {
    ctx.drawImage(img, -iw / 2, -ih / 2);
  }
  ctx.restore();
};

export const renderMultiplane = (
  ctx: CanvasRenderingContext2D,
  data: unknown,
): void => {
  const scene = data as Scene | null;
  if (!scene) return;

  // DPR scale — apply once. setTransform resets any prior transform so
  // we start each frame from identity-times-DPR.
  const dpr =
    (typeof globalThis !== "undefined" && typeof (globalThis as { devicePixelRatio?: number }).devicePixelRatio === "number")
      ? (globalThis as { devicePixelRatio: number }).devicePixelRatio
      : 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Clear the CSS-pixel area. The backing store may extend further if
  // CSS sizing has rounded to a different rect; that's harmless — the
  // unclear region just shows whatever was there before, off-screen.
  ctx.clearRect(0, 0, scene.width, scene.height);

  // Camera rotation: applied around the canvas center BEFORE per-layer
  // drawing. Saves + restores once outside the layer loop. Default 0
  // (most scenes don't need a roll, but stylized shots sometimes do).
  const camRot = scene.camera.rotation ?? 0;
  if (camRot !== 0) {
    ctx.save();
    ctx.translate(scene.width / 2, scene.height / 2);
    ctx.rotate(camRot);
    ctx.translate(-scene.width / 2, -scene.height / 2);
  }

  const focal = scene.camera.focal ?? DEFAULT_FOCAL;

  // Layers are pre-sorted z DESCENDING (back-to-front for painter's
  // algorithm). We walk them in order without re-sorting.
  for (const layer of scene.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    for (const drawing of layer.drawings) {
      drawDrawing(ctx, drawing, layer, scene, focal);
    }
  }

  if (camRot !== 0) ctx.restore();
};
