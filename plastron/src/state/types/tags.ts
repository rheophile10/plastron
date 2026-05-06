// ========================================================================
// Format-tagged value protocol
//
// Cel values may be opaque references with a 2-byte format tag — numpy
// arrays, sqlite blobs, DataFrame handles, stream handles, Eshkol
// closures, exact rationals, complex numbers, etc. — rather than plain
// JSON. Compatible with xitdb's format-tag scheme.
//
// A tagged value is the literal shape `{__tag: "<tag>", value: <opaque>}`.
// Plastron core treats the inner value as opaque; per-tag protocol
// entries (registered alongside the tag) supply the operations that
// would otherwise be unsafe to perform on opaque data:
//
//   • comparator   — used by defaultIsChanged when both sides carry the
//                    same tag. Falls back to Object.is when none.
//   • release      — called when a cel value is superseded or its cel
//                    is removed. Frees handler-side resources (WASM
//                    allocations, workers, prepared statements).
//   • serialize /  — round-trips through xitdb / segment dumps. Tags
//     deserialize    whose values cannot meaningfully serialize declare
//                    serializable: false.
//
// A kind handler that returns format-tagged opaque values is responsible
// for registering the corresponding tag protocol — typically at the
// same time it registers the kind. Failing to register `release` for a
// handle-style tag is a memory leak; failing to register `comparator`
// is a correctness bug producing spurious cascades.
// ========================================================================

/** Discriminator on tagged values. Two-byte tag string keeps it small
 *  and aligns with xitdb's format-tag conventions. */
export const TAG_FIELD = "__tag";
export const TAG_VALUE_FIELD = "value";

export interface TaggedValue<V = unknown> {
  __tag: string;
  value: V;
}

export interface TagProtocol<V = unknown> {
  /** Tag identifier (e.g. "rat", "big", "cx", "eh", "sh"). */
  key: string;

  /** Compare two values of this tag. Default Object.is when not registered. */
  comparator?: (a: V, b: V) => boolean;

  /** Free handler-side resources (WASM allocs, file handles, workers,
   *  prepared statements). Called when a cel value is replaced or its
   *  cel is flushed. Errors swallowed by the cycle. */
  release?: (value: V) => void;

  /** Serialize for persistence. Must produce a JSON-shape value. */
  serialize?: (value: V) => unknown;

  /** Inverse of serialize. */
  deserialize?: (data: unknown) => V;

  /** When false, segments containing tagged values of this tag are
   *  flagged as session-bound (do not survive xitdb / file persistence).
   *  Defaults to true (or to whatever serialize/deserialize imply). */
  serializable?: boolean;
}

export type TagRegistry = Record<string, TagProtocol>;

/** Predicate: is this value a TaggedValue? Conservative — only
 *  matches plain objects with the discriminator key. */
export const isTaggedValue = (v: unknown): v is TaggedValue => {
  if (v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return false;
  return TAG_FIELD in v && typeof (v as Record<string, unknown>)[TAG_FIELD] === "string";
};

/** Convenience constructor. */
export const tagged = <V>(tag: string, value: V): TaggedValue<V> => ({
  __tag: tag,
  value,
});
