import type { TagProtocol } from "../../../../plastron/src/index.js";

// ========================================================================
// tag: crack
//
// An opaque-style tagged value representing the heat-induced fissure on
// the plastron. Carries the pattern (Y, X, I, double-Y, indistinct) plus
// an intensity scalar and free-form notes.
//
// The comparator declares two cracks "the same" when their patterns
// match — intensity differences don't trigger a fresh divination,
// because the augur reads patterns, not magnitudes. This is exactly
// the kind of semantic equality that the format-tagged value protocol
// is designed to express: kind handlers and tag protocols decide what
// equality means for opaque domain values, instead of relying on
// Object.is.
//
// `release` is a noop here (cracks hold no resources), but is registered
// to demonstrate the protocol shape — a real handler would free WASM
// allocations, kill a worker, finalize a prepared statement, etc.
// ========================================================================

export interface CrackValue {
  pattern: "Y" | "X" | "I" | "double-Y" | "indistinct";
  /** 0..1 — how strongly the crack appeared. */
  intensity: number;
  /** Free-form lineage notes — rationale, etymology, observations. */
  notes: string[];
}

export const crackTag: TagProtocol<CrackValue> = {
  key: "crack",
  comparator: (a, b) => a.pattern === b.pattern,
  release: () => { /* no resources to free; protocol shape demo */ },
  serialize: (v) => v,
  deserialize: (v) => v as CrackValue,
};
