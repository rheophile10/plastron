import type { Key } from "./index.js";

// ============================================================================
// WIT — wasm Interface Types, the cross-language type system for cels
// living in a wasm domain (kind: "wat", "javy", "py", …). v3 subset:
// primitives + list + record + variant. No tuples, options, results, or
// resources yet; we add them as use cases land.
//
// Source of truth lives here in TypeScript; the JSON schema for any
// individual WIT type is encoded into its SchemaCel (see 甲骨坑/
// wasm-types.json) so the round-trip stays a normal Schema with a
// "wasm" kind discriminator (see types/schemas.ts).
//
// Scalars (i32, f64, …) survive postMessage cheaply and stay inline on
// cel.v. Composites (string, list, record, variant) need indirection
// through a per-kind value table — represented as a WasmHandle. The
// table lives in the kind segment's worker; v1 (main-thread) doesn't
// materialize composites yet, but the handle shape is fixed here so
// task 7 (bridges) and the eventual worker layer match.
// ============================================================================

export type WitPrimitive =
  | { kind: "bool" }
  | { kind: "u32" }
  | { kind: "s32" }
  | { kind: "u64" }
  | { kind: "s64" }
  | { kind: "f32" }
  | { kind: "f64" }
  | { kind: "char" }
  | { kind: "string" };

export type WitComposite =
  | { kind: "list";    element: WitType }
  | { kind: "record";  fields:  Record<string, WitType> }
  | { kind: "variant"; cases:   Record<string, WitType | null> };

export type WitType = WitPrimitive | WitComposite;

/** Discriminator predicate for primitives. Useful in bridge cels and
 *  precompute layers that route scalars (inline JS numbers / BigInts /
 *  booleans) differently from composites (handles into worker tables). */
export const isWitPrimitive = (t: WitType): t is WitPrimitive => {
  switch (t.kind) {
    case "bool": case "u32": case "s32": case "u64": case "s64":
    case "f32":  case "f64": case "char": case "string": return true;
    default: return false;
  }
};

/** A reference to a wasm-domain value living in some kind segment's
 *  worker-side value table. Used as the JS-visible cel.v for composite
 *  wasm types (strings, lists, records, variants).
 *
 *  v1 — no workers, so composites can't actually be allocated as
 *  handles yet. The shape is defined now so when workers land the
 *  bridge protocol (task 7) and precompute layers (task 8) know what
 *  to construct. */
export interface WasmHandle {
  kind: Key;      // "wat", "py", "javy" — names the kind segment that owns the table
  type: WitType;  // the schema this handle is bound to
  ref: number;    // index into the kind segment's value table
}

export const isWasmHandle = (v: unknown): v is WasmHandle => {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.kind === "string"
    && typeof o.ref === "number"
    && typeof o.type === "object" && o.type !== null;
};
