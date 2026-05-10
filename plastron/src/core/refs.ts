// ============================================================================
// refs — resolver helpers + default slot accessors for ref cels.
//
// A ref cel holds no value of its own; its `cel.ref = { source, slot }`
// names another cel and a slot inside that cel's value. Every read goes
// through `resolveValue` (here), every write through `writeThroughRef`.
//
// The accessor protocol (types/refs.ts) is the only place that knows
// how to mutate a source's slot correctly while bumping `gen` on
// in-place envelopes. The kernel never reaches around the accessor.
//
// Cycle safety: ref-to-ref chains (rare; usual cause is a rename of
// a column key) are followed up to MAX_REF_DEPTH. Going deeper throws
// rather than looping forever — the depth is the only cycle detection
// this layer does.
//
// Memory accounting: ref cels have a distinct, small footprint. The
// `refCelByteLength` lambda registered here returns a fixed constant
// for any cel with `cel.ref` set. The perf-tracking accountant in
// core/perf.ts checks for `cel.ref` BEFORE consulting the schema's
// byteLength, so the source's column accounts for the bytes the slot
// owns and the ref accounts only for its own envelope.
// ============================================================================

import type { Cel, Fn, Key, LambdaKey, SlotAccessor, State, TagKey } from "../types/index.js";

/** How deep we follow ref-to-ref chains before giving up. 16 hops is
 *  more than enough for any sane consolidate-then-rename workflow; a
 *  longer chain almost certainly means a cycle. */
export const MAX_REF_DEPTH = 16;

/** Registry key for the default plain-array slot accessor. Stored in
 *  state.slotAccessors so segments (and the dispatcher below) can find
 *  it by key. */
export const DEFAULT_ARRAY_ACCESSOR_KEY: TagKey = "__defaultArray";
export const DEFAULT_OBJECT_ACCESSOR_KEY: TagKey = "__defaultObject";

/** Conventional registry key for the ref-cel byteLength lambda. The
 *  perf-tracking accountant looks this up via state.fns.get, but the
 *  per-cel byte estimation also short-circuits on `cel.ref` directly
 *  for the common path — see core/perf.ts `sizeOfCel`. */
export const REF_CEL_BYTELENGTH_KEY: LambdaKey = "refCelByteLength";

/** Approximate footprint of a ref cel — cel object header + a handful
 *  of populated property slots + the ref envelope itself. The number
 *  is deliberately rough; the goal is order-of-magnitude accounting,
 *  not heap auditing. Picked to align with the constants used in
 *  perf-bytes.ts (24-byte header, ~8 bytes per populated slot). */
export const REF_CEL_BYTES = 80;

// ── Default accessors for plain shapes ─────────────────────────────────────

/** Plain-array accessor. Reads index, writes via shallow clone (the
 *  contract is that plain arrays don't carry a `gen` counter, so the
 *  only safe write is wholesale replacement so reference inequality
 *  drives the cascade). */
export const defaultArrayAccessor: SlotAccessor = {
  read: (src, slot) => {
    if (!Array.isArray(src)) return undefined;
    return (src as unknown[])[slot as number];
  },
  write: (src, slot, value) => {
    const a = Array.isArray(src) ? (src as unknown[]).slice() : [];
    a[slot as number] = value;
    return a;
  },
  validate: (src, slot) => {
    if (typeof slot !== "number") return false;
    if (!Array.isArray(src)) return false;
    return slot >= 0 && slot < (src as unknown[]).length;
  },
};

/** Plain-object accessor. Slot is the property name. Writes shallow-
 *  clone the object so reference inequality drives the cascade. */
export const defaultObjectAccessor: SlotAccessor = {
  read: (src, slot) => {
    if (!src || typeof src !== "object") return undefined;
    return (src as Record<string, unknown>)[slot as string];
  },
  write: (src, slot, value) => {
    const o = (src && typeof src === "object")
      ? { ...(src as Record<string, unknown>) }
      : {};
    o[slot as string] = value;
    return o;
  },
  validate: (src, slot) => {
    if (typeof slot !== "string") return false;
    if (!src || typeof src !== "object") return false;
    return true;
  },
};

// ── Accessor resolution ─────────────────────────────────────────────────────

/** Pick the right accessor for a source cel + its current value.
 *  Resolution order:
 *    1. source.tag → state.slotAccessors.get(tag)   (specific)
 *    2. shape of source value: Array → default-array accessor
 *    3. shape of source value: object → default-object accessor
 *    4. nothing matches → undefined (caller surfaces the dangling case) */
export const accessorFor = (
  state: State,
  sourceTag: TagKey | undefined,
  sourceValue: unknown,
): SlotAccessor | undefined => {
  if (sourceTag !== undefined) {
    const a = state.slotAccessors.get(sourceTag);
    if (a) return a;
  }
  if (Array.isArray(sourceValue)) {
    return state.slotAccessors.get(DEFAULT_ARRAY_ACCESSOR_KEY) ?? defaultArrayAccessor;
  }
  if (sourceValue && typeof sourceValue === "object") {
    return state.slotAccessors.get(DEFAULT_OBJECT_ACCESSOR_KEY) ?? defaultObjectAccessor;
  }
  return undefined;
};

// ── Resolver helpers ────────────────────────────────────────────────────────

/** Read the resolved value of a cel. For non-ref cels, returns cel.v.
 *  For ref cels, follows the ref chain (capped at MAX_REF_DEPTH to
 *  detect cycles) and reads the slot via the appropriate accessor.
 *  Returns undefined for dangling refs (source removed) or when no
 *  accessor matches the source's shape. Accessor `read` errors propagate
 *  to the caller — fireCel's input-gather catches them via cel.dynamic
 *  and the cascade's normal error surface. */
export const resolveValue = (state: State, cel: Cel, depth = 0): unknown => {
  if (!cel.ref) return cel.v;
  if (depth >= MAX_REF_DEPTH) {
    throw new Error(
      `ref chain too deep at "${cel.key}" (limit ${MAX_REF_DEPTH}). ` +
      `Possible cycle in ref→source chain.`,
    );
  }
  const source = state.cels.get(cel.ref.source);
  if (!source) return undefined;
  const sourceValue = resolveValue(state, source, depth + 1);
  if (sourceValue === undefined || sourceValue === null) return undefined;
  const accessor = accessorFor(state, source.tag, sourceValue);
  if (!accessor) return undefined;
  return accessor.read(sourceValue, cel.ref.slot);
};

/** Write a value through a ref. Resolves the source, calls the
 *  accessor's write, then either marks the source mutated in place
 *  (same-reference return) or installs the new source value
 *  wholesale (different-reference return). Returns the source key
 *  the cascade should fire from. Throws on dangling source / missing
 *  accessor — caller decides whether to surface the error.
 *
 *  NOTE: this helper does NOT run the cascade. The caller (input.set
 *  / batch / setCel / setCelBatch) is responsible for that, because
 *  the surrounding write may want to coalesce many ref writes into a
 *  single cascade pass. */
export const writeThroughRef = (
  state: State,
  cel: Cel,
  value: unknown,
): { sourceKey: Key; replaced: boolean; newSourceValue: unknown } => {
  if (!cel.ref) {
    throw new Error(`writeThroughRef: cel "${cel.key}" is not a ref`);
  }
  const source = state.cels.get(cel.ref.source);
  if (!source) {
    throw new Error(
      `writeThroughRef: ref source "${cel.ref.source}" for "${cel.key}" not found`,
    );
  }
  const sourceValue = resolveValue(state, source);
  const accessor = accessorFor(state, source.tag, sourceValue);
  if (!accessor) {
    throw new Error(
      `writeThroughRef: no slot accessor for source "${source.key}" ` +
      `(tag=${source.tag ?? "<none>"}). Register one in state.slotAccessors.`,
    );
  }
  if (accessor.validate && sourceValue !== undefined && sourceValue !== null) {
    if (!accessor.validate(sourceValue, cel.ref.slot)) {
      throw new Error(
        `writeThroughRef: slot ${JSON.stringify(cel.ref.slot)} ` +
        `out of range for source "${source.key}"`,
      );
    }
  }
  const next = accessor.write(sourceValue, cel.ref.slot, value);
  return {
    sourceKey: source.key,
    replaced: next !== sourceValue,
    newSourceValue: next,
  };
};

/** Validate a single ref cel against the live state. Returns null when
 *  the ref is well-formed (source exists, accessor available, slot in
 *  range); returns an error message otherwise. Used by precompute /
 *  hydrate to surface dangling refs before they corrupt a cycle. */
export const validateRef = (state: State, cel: Cel): string | null => {
  if (!cel.ref) return null;
  const source = state.cels.get(cel.ref.source);
  if (!source) return `ref source "${cel.ref.source}" not found for cel "${cel.key}"`;
  // Don't follow the chain at validate time — chain depth is checked
  // at read/write time via MAX_REF_DEPTH. We only care that the
  // immediate source exists and the slot type matches the accessor.
  const sourceValue = source.ref ? undefined : source.v;
  const accessor = accessorFor(state, source.tag, sourceValue);
  if (!accessor) {
    // No accessor — only an error when the source has a tag we don't
    // know about. Sources without a tag fall back to default
    // accessors at read time once the value materializes.
    if (source.tag !== undefined && !state.slotAccessors.has(source.tag)) {
      return `no slot accessor for source "${source.key}" (tag=${source.tag})`;
    }
    return null;
  }
  if (accessor.validate && sourceValue !== undefined && sourceValue !== null) {
    if (!accessor.validate(sourceValue, cel.ref.slot)) {
      return `slot ${JSON.stringify(cel.ref.slot)} out of range for "${source.key}"`;
    }
  }
  return null;
};

// ── Per-cel byte accounting ────────────────────────────────────────────────

/** Lambda body — returns the fixed constant footprint of a ref cel.
 *  Registered under REF_CEL_BYTELENGTH_KEY in coreFns so the perf-
 *  tracking accountant (or any host code) can call it via state.fns.
 *  The hot path in core/perf.ts checks `cel.ref` directly to avoid
 *  the lookup, but the registered fn lets host tooling estimate ref
 *  cost without depending on the kernel internals. */
export const refCelByteLength: Fn = (_v: unknown): number => REF_CEL_BYTES;

// ── Coexistence guard ──────────────────────────────────────────────────────

/** Returns true if installing a ref on a cel would create an illegal
 *  combination (ref + f, ref + l, ref + non-null v). Used by hydrate
 *  and applyTripleAtomic to refuse the install before mutating. */
export const refConflicts = (cel: Cel): string | null => {
  if (cel.f !== undefined) return `cel "${cel.key}" has source (f); clear it before installing ref`;
  if (cel.l !== undefined) return `cel "${cel.key}" has lambda (l); clear it before installing ref`;
  if (cel.v !== undefined && cel.v !== null) {
    return `cel "${cel.key}" has a value; clear it (v: undefined) before installing ref`;
  }
  return null;
};
