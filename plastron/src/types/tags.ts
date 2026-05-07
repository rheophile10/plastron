import type { Key } from "./index.js";

export type TagKey = Key;

// ============================================================================
// Tag handlers — per-format protocols for opaque cel values.
//
// Cels usually hold JSON-shaped values; the kernel handles them with
// reference equality, no-op serialize, and GC-managed cleanup. For
// values the kernel can't introspect (Buffers, DB handles, streams,
// React elements, Immutable.js maps), the host registers a tag and
// the value-bearing cels declare cel.tag = <tag-key>.
//
// All three callbacks are optional. Missing callbacks fall through to
// default behavior (`!==`, identity, no-op release).
//
// Tag handlers contain functions and don't round-trip through JSON —
// they ship with host code, registered into state.tagRegistry at
// runtime. The cel.tag identifier itself does round-trip.
// ============================================================================

export interface TagHandler {
  /** Returns true if the value changed. Used in change suppression
   *  when no per-cel `_isChanged` override is set. */
  comparator?: (prev: unknown, next: unknown) => boolean;
  /** Convert the value to a JSON-serializable form for dehydrate. */
  serialize?: (v: unknown) => unknown;
  /** Free any resources held by this value. Called when the value is
   *  replaced or the owning cel is overwritten. Errors are swallowed
   *  so a misbehaving handler can't block teardown. */
  release?: (v: unknown) => void;
}
