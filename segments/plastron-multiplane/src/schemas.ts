import { z } from "zod";
import type { Drawing, Layer, Scene } from "./types.js";

// ============================================================================
// Schemas + lambda keys for the three envelopes.
//
// Identity-only Zod schemas — they exist as Map keys for the kernel's
// auto-wire. Validation strictness is intentionally minimal; the multiplane
// renderer trusts that callers built the shapes correctly. The byteLength
// estimators + isChanged comparators are the load-bearing surface.
//
// Cels declare ONE of these schemas. The most common is `sceneSchema` —
// the cel bound to plastron-canvas's channel is typically the Scene cel,
// not individual Drawing or Layer cels. Drawing / Layer schemas are
// available for callers that want fine-grained reactive cels per
// drawing or per layer (the gen-bump path works through a Column-of-
// drawings storage too, post-HN territory).
// ============================================================================

export const DRAWING_SCHEMA_KEY = "plastronMultiplane:drawing" as const;
export const LAYER_SCHEMA_KEY   = "plastronMultiplane:layer"   as const;
export const SCENE_SCHEMA_KEY   = "plastronMultiplane:scene"   as const;

export const DRAWING_IS_CHANGED_KEY = "plastronMultiplane:drawingIsChanged" as const;
export const LAYER_IS_CHANGED_KEY   = "plastronMultiplane:layerIsChanged"   as const;
export const SCENE_IS_CHANGED_KEY   = "plastronMultiplane:sceneIsChanged"   as const;

export const DRAWING_BYTELENGTH_KEY = "plastronMultiplane:drawingByteLength" as const;
export const LAYER_BYTELENGTH_KEY   = "plastronMultiplane:layerByteLength"   as const;
export const SCENE_BYTELENGTH_KEY   = "plastronMultiplane:sceneByteLength"   as const;

export const drawingSchema: z.ZodType = z.unknown();
export const layerSchema:   z.ZodType = z.unknown();
export const sceneSchema:   z.ZodType = z.unknown();

// ── Gen-counter isChanged ──────────────────────────────────────────────────

export const drawingIsChanged = (prev: unknown, next: unknown): boolean => {
  if (prev === next) return false;
  const a = prev as Drawing | null | undefined;
  const b = next as Drawing | null | undefined;
  if (!a || !b) return a !== b;
  return a.gen !== b.gen;
};

export const layerIsChanged = (prev: unknown, next: unknown): boolean => {
  if (prev === next) return false;
  const a = prev as Layer | null | undefined;
  const b = next as Layer | null | undefined;
  if (!a || !b) return a !== b;
  return a.gen !== b.gen;
};

export const sceneIsChanged = (prev: unknown, next: unknown): boolean => {
  if (prev === next) return false;
  const a = prev as Scene | null | undefined;
  const b = next as Scene | null | undefined;
  if (!a || !b) return a !== b;
  return a.gen !== b.gen;
};

// ── byteLength estimators ──────────────────────────────────────────────────
//
// Approximate. Used for perf-tracking display, not heap auditing. ImageBitmap
// dimensions are exact when available (width × height × 4 for RGBA); other
// image kinds fall through to a fixed estimate so the accountant stays
// non-zero.

const ENVELOPE_OVERHEAD = 96;
const IMAGE_FALLBACK_BYTES = 64 * 1024;

const imageBytes = (img: unknown): number => {
  if (!img || typeof img !== "object") return 0;
  const { width, height } = img as { width?: number; height?: number };
  if (typeof width === "number" && typeof height === "number") {
    return width * height * 4;
  }
  return IMAGE_FALLBACK_BYTES;
};

export const drawingByteLength = (v: unknown): number => {
  if (v == null) return 0;
  const d = v as Drawing;
  let s = ENVELOPE_OVERHEAD;
  s += imageBytes(d.lineArt);
  if (d.fills) {
    for (const [k, val] of Object.entries(d.fills)) {
      s += k.length * 2 + (typeof val === "string" ? val.length * 2 : 0);
    }
  }
  return s;
};

export const layerByteLength = (v: unknown): number => {
  if (v == null) return 0;
  const l = v as Layer;
  let s = ENVELOPE_OVERHEAD;
  if (Array.isArray(l.drawings)) {
    for (const d of l.drawings) s += drawingByteLength(d);
  }
  return s;
};

export const sceneByteLength = (v: unknown): number => {
  if (v == null) return 0;
  const sc = v as Scene;
  let s = ENVELOPE_OVERHEAD;
  if (Array.isArray(sc.layers)) {
    for (const layer of sc.layers) s += layerByteLength(layer);
  }
  return s;
};
