import type { z } from "zod";
import type { Key } from "./index.js";
import type { LambdaKey } from "./lambdas.js";

export type SchemaKey = Key;

// ============================================================================
// WasmLayout — structural description of a value's shape in a way that
// maps cleanly to WebAssembly linear memory and to cross-language WASM
// toolchains (Rust, C, AssemblyScript, Pyodide, Emscripten, …). The
// type is the documentation: a schema that has a corresponding
// WasmLayout is in the wasm-friendly subset; one that doesn't isn't.
//
// The vocabulary mirrors the WebAssembly Component Model's interface
// types (record, variant, option, list, tuple) without committing to
// the spec itself — it's a structural description plastron understands,
// not an importable WIT document.
//
// What's expressible:
//   • Numeric primitives (f64, f32, i32, i64, u32, u64) and bool
//   • UTF-8 strings (length-prefixed, encoding decided by the codec)
//   • Lists of T
//   • Records with named, ordered fields (struct-shaped)
//   • Variants — tagged unions where each case carries an optional
//     payload (sum types)
//   • Optionals (T or absent)
//   • Tuples (positional fixed-size)
//   • References to other registered schemas (for composition)
//
// What's deliberately not expressible:
//   • Open-ended objects (Record<string, T>) — pick `list` of records
//     with explicit key field instead.
//   • Recursive types via lazy/cycles — possible but every cross-
//     language toolchain handles these inconsistently. Use refs with
//     bounded depth at the marshalling layer.
//   • Refinements, transforms, brands — semantic operations that
//     don't survive the boundary in any wire format.
//   • Functions — not value types.
//
// The kernel itself never inspects WasmLayout. It rides along in
// SchemaMetadata so partition handlers, marshallers, and codegen tools
// can query it (state.schemaMetadata.get(schemaKey)?.wasmLayout) to
// derive memory layout, generate bindings, or validate that a cel's
// schema is acceptable for a given WASM partition.
// ============================================================================

export type WasmLayout =
  | { kind: "f64" }
  | { kind: "f32" }
  | { kind: "i32" }
  | { kind: "i64" }
  | { kind: "u32" }
  | { kind: "u64" }
  | { kind: "bool" }
  | { kind: "string" }
  | { kind: "list";    element: WasmLayout }
  | { kind: "record";  fields: Array<{ name: string; type: WasmLayout }> }
  | { kind: "variant"; cases:  Array<{ tag: string; type?: WasmLayout }> }
  | { kind: "option";  type: WasmLayout }
  | { kind: "tuple";   elements: WasmLayout[] }
  | { kind: "ref";     schema: SchemaKey };

/** Static description of a schema — sits in state.schemaMetadata
 *  parallel to the live Zod validator in state.schemas. Travels with
 *  segments as JSON. */
export interface SchemaMetadata {
  key: SchemaKey;
  /** LambdaKey of the change-detection fn for values of this schema.
   *  Resolved at hydrate to state.fns.get(isChanged) and cached on
   *  every cel that declares this schema as cel._isChanged. Falsy =
   *  fall back to reference equality (===). Returns true when the
   *  value materially changed. */
  isChanged?: LambdaKey;
  /** Optional LambdaKey of a diff fn for values of this schema. When
   *  defined, the kernel calls it on (prev, next) after isChanged
   *  reports true and stores the result on cel._diff. The diff shape
   *  is domain-specific — VNode patches, JSON-pointer ops, audit
   *  events, replication deltas — and consumers read it from
   *  cel._diff. The kernel itself never inspects the value. */
  diff?: LambdaKey;
  /** Optional encode/decode pair for marshalling values of this
   *  schema across a binary boundary. Each key references a fn in
   *  state.fns:
   *    encode: (value: unknown) => Uint8Array
   *    decode: (bytes: Uint8Array) => unknown
   *
   *  Consumed by partition handlers and other WASM/worker bridges
   *  that need to move cel values across the Web↔WASM boundary
   *  without re-inventing serialization. The kernel itself never
   *  invokes these — it just stores the metadata for handlers to
   *  query (state.schemaMetadata.get(schemaKey)?.codec).
   *
   *  The wire format is the codec's choice — JSON+UTF-8, MsgPack,
   *  CBOR, FlatBuffers, raw f64s for tight numerical kernels. Both
   *  ends of the boundary have to agree; this slot just lets a
   *  schema name the agreed pair. When absent, hosts can fall back
   *  to ad-hoc marshalling on a per-handler basis. */
  codec?: { encode: LambdaKey; decode: LambdaKey };
  /** Structural layout of values matching this schema, expressed in
   *  the wasm-friendly type vocabulary (see WasmLayout above).
   *
   *  Optional. A schema with a wasmLayout is in the wasm-friendly
   *  subset and can be a partition member, a WASM-bridge boundary,
   *  or a cross-language argument shape. A schema without one is
   *  JS-only — marshalling-aware consumers should refuse to bridge
   *  values matching it, falling back to JSON+UTF-8 only when both
   *  ends agree to that contract.
   *
   *  Travels with segments as JSON via SchemaMetadata. */
  wasmLayout?: WasmLayout;
  /** Optional byte-size estimator for values matching this schema.
   *  Returns approximate bytes consumed by the value. Used by the
   *  perf-tracking pass when summing per-cel memory. Falsy = fall back
   *  to the kernel's default estimator (typed arrays exact, primitives
   *  by table, objects by JSON.stringify length, with a depth cap).
   *  Resolved at runtime via state.fns.get(meta.byteLength). Estimators
   *  must be sync. */
  byteLength?: LambdaKey;
}

// ============================================================================
// Schema maps
//
// Schemas live in two forms:
//   • Hydrated — live Zod validators, used at runtime.
//   • Dehydrated — JSON Schema documents (the output of z.toJSONSchema),
//     used on disk and inside Segment payloads.
//
// The round-trip is lossy: refinements, transforms, and brands do NOT
// survive a hydrate → dehydrate → hydrate cycle. Treat the dehydrated
// form as a *projection*, not a full serialization, of the live schema.
// ============================================================================

/** Convert a live Map<SchemaKey, ZodType> into its JSON-serializable
 *  form. Typically implemented by mapping z.toJSONSchema over each entry. */
export type DehydrateSchemas = (
  schemas: Map<SchemaKey, z.ZodType>,
) => Record<SchemaKey, z.core.JSONSchema.JSONSchema>;

/** Convert a Record<SchemaKey, JSONSchema> back into live Zod
 *  validators. Lossy (see file header). */
export type HydrateSchemas = (
  schemas: Record<SchemaKey, z.core.JSONSchema.JSONSchema>,
) => Map<SchemaKey, z.ZodType>;
