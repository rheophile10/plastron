import { z } from "zod";

// ============================================================================
// Schema for "anything paintable into a plastron-canvas root."
//
// Identity-only — exists as a Map key in state.schemas so the kernel's
// auto-wire loop can attach `_isChanged` (gen-counter) to every cel that
// declares this schema. Validation strictness is intentionally minimal;
// the painter doesn't know what the cel value means, only that the
// user's draw fn does.
//
// Cels can opt out of declaring this schema entirely — the kernel falls
// back to reference equality, which is fine for callers that immutably
// rebuild the value on every update. Cels that mutate in place + bump a
// `gen` counter MUST declare this schema (or another with a compatible
// isChanged) so change detection picks up the gen bump.
//
// Specific renderers (plastron-multiplane) ship their own schemas for
// their specific shapes (Scene, Layer, Drawing) — those carry the same
// gen-counter contract but allow per-shape isChanged and byteLength
// estimators. A cel chooses ONE schema; it doesn't compose with this one.
// ============================================================================

export const DRAWING_SCHEMA_KEY = "plastronCanvas:drawing" as const;
export const DRAWING_IS_CHANGED_KEY = "plastronCanvas:drawingIsChanged" as const;

export const drawingSchema: z.ZodType = z.unknown();

/** Gen-counter isChanged. Pairs with a value that carries a `gen: number`
 *  field. Same shape as `plastron-collections:columnIsChanged`. Reference
 *  equality short-circuit + gen comparison. Values without a `gen` field
 *  fall through to reference inequality (which the caller's `prev !== next`
 *  has already established). */
export const drawingIsChanged = (prev: unknown, next: unknown): boolean => {
  if (prev === next) return false;
  const a = prev as { gen?: number } | null | undefined;
  const b = next as { gen?: number } | null | undefined;
  if (!a || !b) return a !== b;
  if (typeof a.gen === "number" && typeof b.gen === "number") {
    return a.gen !== b.gen;
  }
  // Reference inequality already established → treat as changed.
  return true;
};
