// ============================================================================
// plastron — type barrel
//
// State is four maps: cels, fns, fnMetadata, schemas.
//
//   • Cels hold values. A lambda cel additionally has `l` (the key of a
//     fn in state.fns) and `inputMap` (names → other cel keys).
//   • Fns hold the callable bodies. Pure functions, no flags.
//   • FnMetadata carries the static description of each lambda — kind,
//     arity, source, schemas, and the `locked` flag that hydrate
//     consults before overwriting an existing fn entry.
//   • Schemas hold live Zod validators. They round-trip through
//     Segments as JSON Schema documents.
//
// A Segment is the JSON-shaped on-disk form: dehydrated cels, optional
// fnMetaData and schemas. Hydrate merges segments + a separate fns
// registry into a State; Dehydrate decomposes a State back to Segments.
// ============================================================================

import type { z } from "zod";
import type { Cel, DehydratedCel } from "./cels.js";
import type { Fn, KindKey, LambdaKey, LambdaMetadata } from "./lambdas.js";
import type { SchemaKey, SchemaMetadata } from "./schemas.js";
import type { TagKey, TagHandler } from "./tags.js";

export type Key = string;

// ============================================================================
// KindHandler — pluggable lambda compilers for non-native kinds.
//
// "native" lambdas are bare JS Fns in state.fns; runCascade calls them
// directly. For other kinds (formula, python, sqlite, scheme, …) the
// host registers a handler in state.kindRegistry. At hydrate, every
// cel whose lambda metadata has `kind: "<non-native>"` is compiled
// once via the matching handler — the result populates cel._fn (used
// by runCascade in preference to the registry lookup) and optionally
// cel._dispose (fired on overwrite / future flush).
//
// `compile` is synchronous. Async setup belongs inside the returned
// fn (lazy on first call), keeping hydrate itself sync.
// ============================================================================

export interface KindHandler {
  compile: (args: {
    cel: Cel;
    meta: LambdaMetadata;
    state: State;
  }) => { fn: Fn; dispose?: () => void };
}

export interface Segment {
  key: Key;
  cels: DehydratedCel[];
  fnMetaData?: Record<LambdaKey, LambdaMetadata>;
  schemas?: Record<SchemaKey, z.core.JSONSchema.JSONSchema>;
  schemaMetadata?: Record<SchemaKey, SchemaMetadata>;
}

export interface State {
  cels: Map<Key, Cel>;
  fns: Map<LambdaKey, Fn>;
  fnMetadata: Map<LambdaKey, LambdaMetadata>;
  schemas: Map<SchemaKey, z.ZodType>;
  schemaMetadata: Map<SchemaKey, SchemaMetadata>;
  /** Per-format protocols for opaque values. Tag handlers don't
   *  round-trip through JSON — host code installs them at runtime. */
  tagRegistry: Map<TagKey, TagHandler>;
  /** Pluggable lambda compilers, keyed by kind. Like tag handlers,
   *  these don't round-trip — host code installs them at runtime. */
  kindRegistry: Map<KindKey, KindHandler>;
}

/** Fold a list of segments + fn registries into the state's four maps
 *  and run precompute. Returns the same state instance for chaining. */
export type Hydrate = (
  state: State,
  segments: Segment[],
  fns: Map<LambdaKey, Fn>[],
) => State;

/** Decompose a State into JSON-serializable Segments. The inverse of
 *  Hydrate. Lossy where Zod schemas carry refinements, transforms, or
 *  brands. */
export type Dehydrate = (state: State) => Segment[];

export type { Cel, DehydratedCel } from "./cels.js";
export type { Fn, KindKey, LambdaKey, LambdaMetadata } from "./lambdas.js";
export type { SchemaKey, SchemaMetadata, DehydrateSchemas, HydrateSchemas } from "./schemas.js";
export type { TagKey, TagHandler } from "./tags.js";
