import type { z } from "zod";
import type { Key } from "./index.js";
import type { LambdaKey } from "./lambdas.js";

export type SchemaKey = Key;

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
