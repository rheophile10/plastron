// ========================================================================
// consolidateInPlace + expandRefs — convert between scalar cels and
// (one column cel + N ref cels) layouts.
//
// Calling convention:
//
//   await consolidateInPlace(state, ["jan","feb",...], "monthlySales", "f64");
//
// Effect:
//   • Reads each scalar cel's current value (numeric coercion).
//   • Builds a Column via columnFrom and installs it under targetKey
//     (tag: "buffer", schema: COLUMN_SCHEMA_KEY, segment: <derived>).
//   • Replaces each scalar cel atomically with a ref cel pointing at
//     slot i of the new column.
//
// Existing inputMap entries (`{ x: "jan" }`) keep working — reads
// resolve through the slot, writes route back through the accessor.
//
// expandRefs is the inverse: given a source key, every ref pointing
// at it is rewritten as a scalar cel holding its current resolved
// value, then the source cel is removed.
//
// Constraints (consolidateInPlace):
//   • Every key must already exist as a variable cel (no f, no l, no
//     pre-existing ref). Throws otherwise.
//   • Every value must coerce to number. Throws otherwise.
//   • targetKey, if it already exists, must be a column-shaped cel
//     compatible with the input length / dtype (idempotency guard).
//
// V1: sequential, not async-parallel. The accessor mutates the source
// in place during column construction, so concurrent slot writes
// would race on the gen counter.
//
// Caveat — perf-accountant numbers around consolidation are misleading:
//
//   The kernel's `stats_precompute.totalEstimatedBytes` counts only a
//   cel's VALUE bytes (8 per number) plus a fixed 80 bytes for ref
//   cels. It does NOT include the ~150-200 bytes of per-cel envelope
//   overhead every cel actually pays in V8. So a "1000 scalar cels →
//   1 column + 1000 refs" transform looks like a regression to the
//   accountant (8K → ~88K bytes) even when the real heap goes the
//   other way (~208K → ~104K, a ~50% reduction).
//
//   When comparing consolidated vs unconsolidated layouts, do not
//   take the bare accountant numbers at face value. Tuning the
//   accountant to credit envelope overhead consistently is a
//   separate follow-up. The collections-demo example prints both the
//   raw accountant numbers and an envelope-aware "actual heap
//   estimate" so the contrast is visible.
// ========================================================================

import type {
  CelTriple, Fn, Key, State,
} from "../../../plastron/src/index.js";
import { columnFrom } from "./builders.js";
import { COLUMN_SCHEMA_KEY, BUFFER_TAG_KEY } from "./schemas.js";
import type { Column, Dtype } from "./types.js";

export interface ConsolidateOptions {
  /** Segment to install the new column cel into. Defaults to the
   *  segment of the first source cel. */
  targetSegment?: Key;
}

export const consolidateInPlace = async (
  state: State,
  keys: Key[],
  targetKey: Key,
  dtype: Dtype = "f64",
  options?: ConsolidateOptions,
): Promise<void> => {
  if (keys.length === 0) {
    throw new Error("consolidateInPlace: keys list is empty");
  }

  // Pre-flight: every source must be a plain variable cel and hold a
  // numeric value. We check before mutating anything so a partial
  // failure leaves the state untouched.
  const values: number[] = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    const cel = state.cels.get(k);
    if (!cel) {
      throw new Error(`consolidateInPlace: cel "${k}" not in state.cels`);
    }
    if (cel.locked) {
      throw new Error(`consolidateInPlace: cel "${k}" is locked`);
    }
    if (cel.l) {
      throw new Error(
        `consolidateInPlace: cel "${k}" is a lambda — cannot consolidate compute cels`,
      );
    }
    if (cel.ref) {
      throw new Error(
        `consolidateInPlace: cel "${k}" is already a ref — un-consolidate first via expandRefs`,
      );
    }
    const v = cel.v;
    if (typeof v !== "number") {
      // Try a forgiving coerce: null/undefined → 0; everything else
      // throws (silently coercing strings would mask data bugs).
      if (v === null || v === undefined) {
        values[i] = 0;
      } else {
        throw new Error(
          `consolidateInPlace: cel "${k}" value is not a number ` +
          `(got ${typeof v}: ${String(v).slice(0, 32)})`,
        );
      }
    } else {
      values[i] = v;
    }
  }

  // Check target key. If it already exists, it must be a column with
  // matching length + dtype (idempotency).
  const existingTarget = state.cels.get(targetKey);
  if (existingTarget) {
    if (existingTarget.locked) {
      throw new Error(`consolidateInPlace: target "${targetKey}" is locked`);
    }
    if (existingTarget.l || existingTarget.ref) {
      throw new Error(
        `consolidateInPlace: target "${targetKey}" already exists as a ` +
        `compute or ref cel; pick a different targetKey`,
      );
    }
    const existing = existingTarget.v as Column | undefined;
    if (existing && (existing.length !== keys.length || existing.dtype !== dtype)) {
      throw new Error(
        `consolidateInPlace: target "${targetKey}" exists with ` +
        `length=${existing.length}/dtype=${existing.dtype}, ` +
        `but consolidating ${keys.length} cels at dtype=${dtype}`,
      );
    }
  }

  const segment = options?.targetSegment
    ?? state.cels.get(keys[0]!)?.segment;

  // Build the column and install/refresh the target cel. We install
  // the cel directly into state.cels to bypass setCel's "no v on
  // compute cel" rule (which doesn't apply here — the column cel is
  // a plain value cel — but going through a single hydrate call would
  // require building a Segment payload, which is heavier than this
  // direct install for what's essentially a one-cel mutation.)
  const column = columnFrom(values, dtype);
  if (existingTarget) {
    existingTarget.v = column;
    existingTarget.tag = BUFFER_TAG_KEY;
    if (state.schemas.has(COLUMN_SCHEMA_KEY)) {
      existingTarget.schema = state.schemas.get(COLUMN_SCHEMA_KEY);
    }
    if (segment !== undefined) existingTarget.segment = segment;
  } else {
    state.cels.set(targetKey, {
      key: targetKey,
      v: column,
      segment,
      tag: BUFFER_TAG_KEY,
      schema: state.schemas.get(COLUMN_SCHEMA_KEY),
    });
  }

  // Convert each source cel to a ref via setCelBatch — atomic across
  // the batch, runs precompute once at the end. We pass v: undefined
  // alongside ref so applyTripleAtomic clears any existing v in the
  // same triple.
  const writes: Record<Key, CelTriple> = {};
  for (let i = 0; i < keys.length; i++) {
    writes[keys[i]!] = {
      v: undefined,
      ref: { source: targetKey, slot: i },
    };
  }
  const setCelBatch = state.fns.get("setCelBatch") as Fn;
  await setCelBatch(state, writes);
};

export const expandRefs = async (
  state: State,
  sourceKey: Key,
): Promise<void> => {
  const source = state.cels.get(sourceKey);
  if (!source) {
    throw new Error(`expandRefs: source "${sourceKey}" not in state.cels`);
  }
  if (source.locked) {
    throw new Error(`expandRefs: source "${sourceKey}" is locked`);
  }

  // Phase 1: resolve every ref's value while the source is still
  //          alive. We DON'T touch state.cels.set yet.
  const get = state.fns.get("get") as Fn;
  const writes: Record<Key, CelTriple> = {};
  const refKeys: Key[] = [];
  for (const cel of state.cels.values()) {
    if (cel.ref?.source !== sourceKey) continue;
    refKeys.push(cel.key);
    const resolved = get(state, cel.key);
    writes[cel.key] = { v: resolved, ref: null };
  }

  // Phase 2: drop the source cel from state.cels FIRST. This is safe
  //          because Phase 1 already captured every ref's resolved
  //          value into `writes`, and the next setCelBatch call
  //          will rebuild the topology indexes from scratch (cel.ref
  //          changes set topoChanged=true, which makes setCelBatch
  //          re-run precompute). Without an existing source cel,
  //          buildChildren naturally drops the source → ref edges.
  state.cels.delete(sourceKey);

  // Phase 3: setCelBatch each ref → scalar. ref-clearing triples set
  //          topoChanged=true, so precompute re-runs once at the end
  //          of the batch with the source cel already gone.
  if (refKeys.length > 0) {
    const setCelBatch = state.fns.get("setCelBatch") as Fn;
    await setCelBatch(state, writes);
  } else {
    // No refs to clear — but we still removed the source. Use a
    // runCycle to re-walk; the next set/setCelBatch will trigger
    // precompute via topoChanged on the next change.
    const runCycle = state.fns.get("runCycle") as Fn;
    await runCycle(state);
  }
};
