// ============================================================================
// plastron-simplified
//
// State is three maps: cels, fns, schemas. That is all.
//
//   • Cels hold values. A lambda cel additionally has `l` (the key of a
//     fn in the fns map) and `inputMap` (names → other cel keys).
//   • Fns hold callable bodies plus a `locked` flag. Cels reference fns
//     by key; fns are not stored in the cel map.
//   • Schemas hold validators (any opaque value here — the kernel does
//     not interpret them).
//
// A Segment is a function registry plus a list of dehydrated cels (and
// optionally schemas). Hydrate merges segments into a state.
//
// `locked: true` on a cel or fn entry means hydrate refuses to upsert
// it. Used to protect the initial entries (hydrate, runCycle) from
// being clobbered by a misbehaving segment.
// ============================================================================

import type { z } from "zod";

export type Key = string;
export type SchemaKey = string;
export type LambdaKey = Key;

export interface Cel {
  key: Key;
  v: unknown;
  /** Key of the fn in state.fns. Presence makes this cel "computed". */
  l?: LambdaKey;
  /** Named inputs → upstream cel keys (or arrays of keys). */
  inputMap?: Record<string, Key | Key[]>;
  segment?: Key;
  schema?: z.ZodType;
  /** Declared wave index. Default 0. Wave N runs fully before wave N+1.
   *  Topological order is computed within each wave. */
  wave?: number;
  /** When true, hydrate will not overwrite this cel. */
  locked?: boolean;
}

/** On-disk / JSON shape. Identical to Cel except `v` is optional
 *  (defaults to null on inflate). */
export interface DehydratedCel {
  key: Key;
  v?: unknown;
  l?: Key;
  inputMap?: Record<string, Key | Key[]>;
  segment?: Key;
  schema?: SchemaKey;
  wave?: number;
  locked?: boolean;
}

// Variadic so the registry accepts both `(input) => …` style fns
// (runCycle, hydrate-ish wrappers) and positional ones (get, set,
// hydrate, dehydrate). The generic params are kept for documentation
// at definition sites but the call signature itself is loose — kernel
// dispatch is dynamic, so registry assignability has to allow it.
export interface Fn<_I = unknown, O = unknown> {
  (...args: any[]): O | Promise<O>;
  /** Only the formula-parser fn carries this. Returns the cel keys a
   *  formula string references; used by hydrate to auto-wire inputMap. */
  extractDeps?: (formula: string) => Key[];
}

/** Static description of a lambda — schema keys, arity, source, etc.
 *  Travels with the cel graph through JSON; not the function itself.
 *  The actual function is supplied separately via a fnRegistry keyed
 *  by lambda key. */
export interface LambdaMetadata {
  key: LambdaKey;
  /** Lambda kind. Defaults to "native" (FnRegistry-backed) when unset.
   *  Other kinds — formula, quickjs, python, sqlite, eshkol, etc. — are
   *  registered by extension packages and must be supplied to runtime()
   *  via the `kinds` option. */
  kind?: string;
  /** Registered schema key for the lambda's input shape. Used for LLM
   *  metadata and for runtime validation when config_recalculation.strictTypes is true. */
  inputSchema?: SchemaKey;
  /** Registered schema key for the lambda's output shape. */
  outputSchema?: SchemaKey;
  /** Positional arity — enforced by formula parsers for exact arg-count match. */
  arity?: number;
  /** Relative path (from src/lambdas/) to the file the fn lives in. */
  filename?: string;
  /** Stringified function body — useful for LLMs and archival. For
   *  non-native kinds, this is the source string the kind handler will
   *  compile (Python source, Scheme expression, SQL query, etc.). */
  source?: string;
  locked?: boolean;
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

/** Convert a live SchemaMap into its JSON-serializable form. Typically
 *  implemented by mapping z.toJSONSchema over each entry. */
export type DehydrateSchemas = (schemas: Map<SchemaKey, z.ZodType>) => Record<SchemaKey, z.core.JSONSchema.JSONSchema>;

/** Convert a DehydratedSchemaMap back into live Zod validators. The
 *  conversion is lossy (see file header) and requires a JSON-Schema →
 *  Zod compiler at the boundary (e.g. `json-schema-to-zod`). */
export type HydrateSchemas = (schemas: Record<SchemaKey, z.core.JSONSchema.JSONSchema>) => Map<SchemaKey, z.ZodType>;



export interface Segment {
  key: Key;
  cels: DehydratedCel[];
  fnMetaData?: Record<LambdaKey, LambdaMetadata>;
  schemas?: Record<SchemaKey, z.core.JSONSchema.JSONSchema>;
}

export interface State {
  cels: Map<Key, Cel>;
  fns: Map<LambdaKey, Fn>;
  schemas: Map<SchemaKey, z.ZodType>;
}

/** Fold a list of segments into the state's three maps and run
 *  precompute. Returns the same state instance for chaining. */
export type Hydrate = (state: State, segments: Segment[], fns: Map<LambdaKey, Fn>[]) => State;

export type Dehydrate = (state: State ) => Segment[];