import { z } from "zod";
import type {
  Cel, DehydratedCel, Dehydrate, DehydrateSchemas, Hydrate,
  HydrateSchemas, Key, SchemaKey, Segment,
} from "../types.js";
import { precompute } from "./precompute.js";

// ============================================================================
// hydrate / dehydrate — round-trip between live State and JSON-shaped
// Segments.
//
//   • Schemas live as Zod validators in State (Map<SchemaKey, ZodType>)
//     and as JSON Schema documents inside Segments.
//   • Cel.schema is the live ZodType; DehydratedCel.schema is the
//     SchemaKey reference. inflate/deflate translate via state.schemas.
//   • Cel-level locked: hydrate skips overwriting locked cels.
//   • Fn implementations come in as `fns: Map<LambdaKey, Fn>[]`,
//     separate from segment payloads (segments only ship LambdaMetadata).
//
// hydrateSchemas (JSON Schema → Zod) is inherently lossy: refinements,
// transforms, and brands cannot be recovered from JSON Schema. The
// inline converter handles the subset of JSON Schema that
// `z.toJSONSchema` emits for the standard Zod constructors.
// ============================================================================

const inflate = (dc: DehydratedCel, schemas: Map<SchemaKey, z.ZodType>): Cel => {
  const cel: Cel = { key: dc.key, v: dc.v ?? null };
  if (dc.l        !== undefined) cel.l        = dc.l;
  if (dc.inputMap !== undefined) cel.inputMap = dc.inputMap;
  if (dc.segment  !== undefined) cel.segment  = dc.segment;
  if (dc.schema   !== undefined) {
    const live = schemas.get(dc.schema);
    if (live) cel.schema = live;
  }
  if (dc.wave     !== undefined) cel.wave     = dc.wave;
  if (dc.locked   !== undefined) cel.locked   = dc.locked;
  return cel;
};

const deflate = (c: Cel, schemaToKey: Map<z.ZodType, SchemaKey>): DehydratedCel => {
  const dc: DehydratedCel = { key: c.key };
  if (c.v        !== null && c.v !== undefined) dc.v = c.v;
  if (c.l        !== undefined) dc.l        = c.l;
  if (c.inputMap !== undefined) dc.inputMap = c.inputMap;
  if (c.segment  !== undefined) dc.segment  = c.segment;
  if (c.schema   !== undefined) {
    const key = schemaToKey.get(c.schema);
    if (key !== undefined) dc.schema = key;
  }
  if (c.wave     !== undefined) dc.wave     = c.wave;
  if (c.locked   !== undefined) dc.locked   = c.locked;
  return dc;
};

const dehydrateSchemas: DehydrateSchemas = (schemas) => {
  const out: Record<SchemaKey, z.core.JSONSchema.JSONSchema> = {};
  for (const [key, zodSchema] of schemas) {
    out[key] = z.toJSONSchema(zodSchema) as z.core.JSONSchema.JSONSchema;
  }
  return out;
};

const jsonSchemaToZod = (
  schema: z.core.JSONSchema.JSONSchema,
  defs?: Record<string, z.core.JSONSchema.JSONSchema>,
): z.ZodType => {
  // $ref into $defs — resolve and recurse.
  if (schema.$ref) {
    const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
    if (m && defs && defs[m[1]]) return jsonSchemaToZod(defs[m[1]], defs);
    return z.unknown();
  }

  // Carry $defs through nested calls so deeper $refs resolve.
  const ds = (schema.$defs as Record<string, z.core.JSONSchema.JSONSchema> | undefined) ?? defs;

  if (schema.const !== undefined) {
    return z.literal(schema.const as string | number | boolean | null);
  }
  if (Array.isArray(schema.enum)) {
    const lits = schema.enum.map((v) => z.literal(v as string | number | boolean | null));
    if (lits.length === 1) return lits[0];
    return z.union(lits as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  }
  if (Array.isArray(schema.anyOf)) {
    const variants = schema.anyOf.map((s) => jsonSchemaToZod(s as z.core.JSONSchema.JSONSchema, ds));
    return z.union(variants as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  }
  if (Array.isArray(schema.oneOf)) {
    const variants = schema.oneOf.map((s) => jsonSchemaToZod(s as z.core.JSONSchema.JSONSchema, ds));
    return z.union(variants as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    let acc = jsonSchemaToZod(schema.allOf[0] as z.core.JSONSchema.JSONSchema, ds);
    for (let i = 1; i < schema.allOf.length; i++) {
      acc = z.intersection(acc, jsonSchemaToZod(schema.allOf[i] as z.core.JSONSchema.JSONSchema, ds));
    }
    return acc;
  }

  switch (schema.type) {
    case "string":  return z.string();
    case "number":  return z.number();
    case "integer": return z.number().int();
    case "boolean": return z.boolean();
    case "null":    return z.null();
    case "array": {
      const items = schema.items;
      if (items && typeof items === "object" && !Array.isArray(items)) {
        return z.array(jsonSchemaToZod(items as z.core.JSONSchema.JSONSchema, ds));
      }
      return z.array(z.unknown());
    }
    case "object": {
      const props = (schema.properties ?? {}) as Record<string, z.core.JSONSchema.JSONSchema>;
      const required = new Set(schema.required ?? []);
      const shape: Record<string, z.ZodType> = {};
      for (const [k, v] of Object.entries(props)) {
        const inner = jsonSchemaToZod(v, ds);
        shape[k] = required.has(k) ? inner : inner.optional();
      }
      return z.object(shape);
    }
  }

  return z.unknown();
};

const hydrateSchemas: HydrateSchemas = (schemas) => {
  const out = new Map<SchemaKey, z.ZodType>();
  for (const [key, jsonSchema] of Object.entries(schemas)) {
    out.set(key, jsonSchemaToZod(jsonSchema));
  }
  return out;
};

export const hydrate: Hydrate = (state, segments, fns) => {
  for (const seg of segments) {
    // Schemas first so cels in the same segment can resolve cel.schema
    // by SchemaKey.
    if (seg.schemas) {
      const live = hydrateSchemas(seg.schemas);
      for (const [key, zodSchema] of live) {
        state.schemas.set(key, zodSchema);
      }
    }
    for (const dc of seg.cels) {
      if (state.cels.get(dc.key)?.locked) continue;
      state.cels.set(dc.key, inflate(dc, state.schemas));
    }
    // seg.fnMetaData carries `locked` flags but isn't currently
    // persisted in state — locked-fn enforcement across hydrate calls
    // requires a state-side metadata store (TODO).
  }

  for (const fnMap of fns) {
    for (const [key, fn] of fnMap) {
      state.fns.set(key, fn);
    }
  }

  precompute(state);
  return state;
};

export const dehydrate: Dehydrate = (state) => {
  // Reverse map for deflating cel.schema (ZodType → SchemaKey).
  const schemaToKey = new Map<z.ZodType, SchemaKey>();
  for (const [key, zodSchema] of state.schemas) {
    schemaToKey.set(zodSchema, key);
  }

  // Group cels by `segment` field. The "core" segment is excluded —
  // its cels are seeded by createInitialState and never change.
  // Cels without a segment fall into "default" so nothing is dropped.
  const bySegment = new Map<Key, DehydratedCel[]>();
  for (const cel of state.cels.values()) {
    if (cel.segment === "core") continue;
    const segKey = cel.segment ?? "default";
    let bucket = bySegment.get(segKey);
    if (!bucket) { bucket = []; bySegment.set(segKey, bucket); }
    bucket.push(deflate(cel, schemaToKey));
  }

  // No per-segment schema ownership in state — pin the whole map to
  // the first emitted segment. Hydrate merges them regardless.
  const dehydratedSchemas = state.schemas.size > 0
    ? dehydrateSchemas(state.schemas)
    : undefined;

  const segments: Segment[] = [];
  let pinned = false;
  for (const [key, cels] of bySegment) {
    const seg: Segment = { key, cels };
    if (!pinned && dehydratedSchemas) {
      seg.schemas = dehydratedSchemas;
      pinned = true;
    }
    segments.push(seg);
  }
  return segments;
};
