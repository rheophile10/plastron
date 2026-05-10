import type { Key } from "./index.js";

export type TagKey = Key;

// ============================================================================
// Tag handlers — per-format protocols for opaque cel values.
//
// Cels usually hold JSON-shaped values; the kernel handles them with
// no-op serialize and GC-managed cleanup. For values the kernel can't
// introspect (Buffers, DB handles, streams, React elements, Immutable.js
// maps), the host registers a tag and the value-bearing cels declare
// cel.tag = <tag-key>.
//
// Both callbacks are optional. Missing callbacks fall through to
// default behavior (identity serialize, no-op release).
//
// Change detection is NOT the tag's concern — it lives on the schema
// (via SchemaMetadata.isChanged). A tag is purely a value-protocol
// declaration: how to serialize for round-trip, how to release on
// teardown.
//
// Tag handlers contain functions and don't round-trip through JSON —
// they ship with host code, registered into state.tagRegistry at
// runtime. The cel.tag identifier itself does round-trip.
// ============================================================================

export interface TagHandler {
  /** Convert the value to a JSON-serializable form for dehydrate. */
  serialize?: (v: unknown) => unknown;
  /** Free any resources held by this value. Called when the value is
   *  replaced or the owning cel is overwritten. Errors are swallowed
   *  so a misbehaving handler can't block teardown. */
  release?: (v: unknown) => void;
  /** Optional byte-size estimator. Same semantics as
   *  SchemaMetadata.byteLength but for opaque-tagged values. Tag
   *  estimator wins over schema estimator when both are present. */
  byteLength?: (v: unknown) => number;
}
