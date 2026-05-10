// ============================================================================
// perf-bytes — default byte-size estimator for cel values.
//
// Used by the perf-tracking precompute snapshot when no schema or tag
// estimator is available. Sync, allocation-light, depth-capped.
//
// Resolution order in the perf pass:
//   1. tag handler `byteLength` (most specific, opaque-aware)
//   2. schema metadata `byteLength` (lambda from state.fns)
//   3. estimateBytes (this file's heuristic)
//
// The numbers here are deliberately rough — V8 / SpiderMonkey hidden-class
// overhead, header sizes, and small-string interning all vary. The goal
// is "useful order-of-magnitude per-segment memory accounting", not
// reproducible byte counts.
// ============================================================================

export const estimateBytes = (v: unknown, depthCap = 4): number => {
  if (v == null) return 0;
  if (typeof v === "boolean") return 4;
  if (typeof v === "number") return 8;
  if (typeof v === "string") return 2 * v.length;
  if (typeof v === "bigint") return 16;
  if (ArrayBuffer.isView(v)) return (v as ArrayBufferView).byteLength;
  if (v instanceof ArrayBuffer) return v.byteLength;
  if (depthCap === 0) return 32;  // give up; conservative constant
  if (Array.isArray(v)) {
    let s = 24;  // array header overhead
    for (const x of v) s += estimateBytes(x, depthCap - 1);
    return s;
  }
  if (typeof v === "object") {
    let s = 24;
    for (const k of Object.keys(v as object)) {
      s += 2 * k.length + 8;  // key + slot
      s += estimateBytes((v as Record<string, unknown>)[k], depthCap - 1);
    }
    return s;
  }
  return 8;
};
