import { z } from "zod";
import type { DehydrateSchemas, HydrateSchemas, SchemaKey } from "../types/index.js";

// ============================================================================
// Schema conversion — round-trip live Zod validators ↔ JSON Schema.
//
// Zod 4's `z.toJSONSchema` produces a JSON Schema document; the inverse
// direction (`jsonSchemaToZod`) is hand-rolled here for the subset of
// JSON Schema that round-trip emits cover. Inherently lossy: refinements,
// transforms, and brands cannot be recovered from JSON Schema. The
// converter handles standard shapes — primitives, enums, unions, $defs
// references, arrays, objects with required/optional properties.
//
// Used by hydrate / dehydrate to translate `Segment.schemas` (JSON
// Schema map) ↔ `state.schemas` (live ZodType map). Hosts that need
// stronger fidelity should keep schemas in code and pass them via
// segments' live schema maps rather than serialized form.
// ============================================================================

export const dehydrateSchemas: DehydrateSchemas = (schemas) => {
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

export const hydrateSchemas: HydrateSchemas = (schemas) => {
  const out = new Map<SchemaKey, z.ZodType>();
  for (const [key, jsonSchema] of Object.entries(schemas)) {
    out.set(key, jsonSchemaToZod(jsonSchema));
  }
  return out;
};
