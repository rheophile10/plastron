import type { CelRef } from "./cels.js";

// ============================================================================
// SlotAccessor — per-source-shape protocol for reading and writing
// individual slots of a consolidated value.
//
// One accessor per TagKey (registered in state.slotAccessors). The
// resolver helpers in core/refs.ts dispatch by source.tag → accessor.
// Sources without a tag fall back to default array / object accessors.
//
// Invariants the accessor must satisfy:
//   • read is pure — given the same source value + slot, returns the
//     same value, never mutates.
//   • write may mutate the source in place (typed-array-backed shapes
//     like Column / Matrix do this and bump source.gen) OR return a
//     new value (plain objects / arrays / Tables that must shallow-
//     clone). The kernel decides what to do based on `next === source`:
//       same reference  → in-place mutation, gen already bumped by the
//                         accessor; the kernel just runs the cascade
//                         from the source key.
//       new reference   → wholesale replacement; the kernel calls
//                         input.set on the source key with the
//                         returned value, which routes through the
//                         normal set / cascade path.
//   • validate is optional. When present, it's called at hydrate time
//     and at write time to catch dangling slots before they corrupt
//     the source value.
// ============================================================================

export interface SlotAccessor {
  /** Read the slot's current value from a source value. Pure; throws
   *  if the slot is out of range or the value's shape doesn't support
   *  it. The kernel catches throws and surfaces them via the errors
   *  cel (when present) or returns undefined. */
  read: (source: unknown, slot: CelRef["slot"]) => unknown;
  /** Write the slot. For typed-array-backed envelopes (Column, Matrix),
   *  mutate in place + bump gen; return the same source reference.
   *  For plain shapes (Table columns map, plain objects, plain arrays),
   *  return a new value the kernel will install via setCel on the
   *  source key. The kernel detects which mode by `next === source`. */
  write: (source: unknown, slot: CelRef["slot"], value: unknown) => unknown;
  /** Validate the slot is in range / well-formed for this source. Used
   *  at hydrate (catches dangling refs) and at write (defends against
   *  silent typed-array index wraparound). Falsy = always valid. */
  validate?: (source: unknown, slot: CelRef["slot"]) => boolean;
}
