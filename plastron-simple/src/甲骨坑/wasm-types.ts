import type { 甲骨, Cel, Fn } from "../types/index.js";
import { bindNativeFns } from "./nativeFn.js";
import seed from "./wasm-types.json" with { type: "json" };

// ============================================================================
// wasm-types — SchemaCels for the WIT primitives that a wasm-domain cel
// can declare via metadata.schema:
//
//   wasm:bool  wasm:i32  wasm:u32  wasm:i64  wasm:u64
//   wasm:f32   wasm:f64  wasm:char wasm:string
//
// Each SchemaCel carries:
//   • kind: "wasm"            — discriminator (see types/schemas.ts)
//   • wit:  WitType           — the WIT shape (see types/wit.ts)
//   • zod:  JSONSchema        — a host-side validator the existing schema
//                               system can use without a wasm runtime
//   • protocols: { isChanged, hydrate, dehydrate }
//                             — fn-key refs into the cels below
//
// v3 composites (list, record, variant) aren't seeded here as static
// schemas — they're per-cel-shape, so a future cel that wants to declare
// `list<wasm:i32>` constructs the schema cel dynamically. Static seeds
// cover the primitives.
//
// Runtime behavior in v1: cel.v stays a JS number / boolean / string /
// BigInt depending on the WIT type. No worker exists yet to put values
// behind handles, so composites can't be materialized — only the
// primitives have functional protocol fns.
// ============================================================================

// Scalar protocols. WIT primitives map onto JS values cleanly enough that
// the protocol implementations are trivial. !Object.is for diff (so NaN
// !== NaN, +0 / -0 don't register as changes) and identity for
// hydrate/dehydrate (JS scalars are JSON-friendly out of the box).
const wasm_scalar_isChanged: Fn = (a, b) => !Object.is(a, b);
const wasm_scalar_hydrate:   Fn = (v) => v;
const wasm_scalar_dehydrate: Fn = (v) => v;

// i64 / u64 protocols. BigInts don't survive JSON.stringify; round-trip
// via decimal string. hydrate accepts either a BigInt (live) or a string
// (dehydrated); dehydrate emits the decimal string form.
const wasm_bigint_hydrate: Fn = (v) =>
  typeof v === "string" ? BigInt(v) : v;
const wasm_bigint_dehydrate: Fn = (v) =>
  typeof v === "bigint" ? v.toString() : v;

export const name = "wasm-types" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["wasm-scalar_isChanged", wasm_scalar_isChanged],
  ["wasm-scalar_hydrate",   wasm_scalar_hydrate],
  ["wasm-scalar_dehydrate", wasm_scalar_dehydrate],
  ["wasm-bigint_hydrate",   wasm_bigint_hydrate],
  ["wasm-bigint_dehydrate", wasm_bigint_dehydrate],
]));
