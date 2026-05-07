import { z } from "zod";
import type {
  Cel, DehydratedCel, Dehydrate, DehydrateSchemas, Fn, Hydrate,
  HydrateSchemas, Key, LambdaKey, LambdaMetadata, SchemaKey,
  Segment, TagHandler, TagKey,
} from "../types/index.js";
import { precompute } from "./precompute.js";

// Cel teardown — fire any installed _dispose hook then release the
// held value via the tag handler. Errors are swallowed so a single
// misbehaving handler can't block hydrate / overwrite / flush.
export const disposeCel = (cel: Cel, tagRegistry: Map<TagKey, TagHandler>): void => {
  if (cel._dispose) {
    try { cel._dispose(); } catch { /* swallow */ }
  }
  if (cel.tag !== undefined && cel.v !== null && cel.v !== undefined) {
    const handler = tagRegistry.get(cel.tag);
    if (handler?.release) {
      try { handler.release(cel.v); } catch { /* swallow */ }
    }
  }
};

// Release the held value (without firing _dispose) — used when a
// cel's value changes but the cel itself stays.
export const releaseValue = (
  v: unknown,
  tag: TagKey | undefined,
  tagRegistry: Map<TagKey, TagHandler>,
): void => {
  if (tag === undefined || v === null || v === undefined) return;
  const handler = tagRegistry.get(tag);
  if (!handler?.release) return;
  try { handler.release(v); } catch { /* swallow */ }
};

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
//   • Fn-level locked: state.fnMetadata holds LambdaMetadata per key.
//     hydrate refuses to overwrite an existing fn whose metadata says
//     locked. createInitialState seeds locked metadata for every entry
//     in coreFns so segments can't replace built-ins.
//   • Formula compilation is itself a registry lookup: state.fns.get("f")
//     is the compiler (string → Fn), and its `.extractDeps` property
//     drives auto-wiring. Hosts swap formula languages by registering a
//     replacement at "f" in the fns parameter — which is why hydrate
//     installs user fns BEFORE inflating cels.
//
// hydrateSchemas (JSON Schema → Zod) is inherently lossy: refinements,
// transforms, and brands cannot be recovered from JSON Schema. The
// inline converter handles the subset of JSON Schema that
// `z.toJSONSchema` emits for the standard Zod constructors.
// ============================================================================

const inflate = (
  dc: DehydratedCel,
  schemas: Map<SchemaKey, z.ZodType>,
  formulaFn: Fn | undefined,
): Cel => {
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
  if (dc.dynamic  !== undefined) cel.dynamic  = dc.dynamic;
  if (dc.tag      !== undefined) cel.tag      = dc.tag;
  if (dc.f        !== undefined) {
    if (dc.l !== undefined && dc.l !== "f") {
      throw new Error(`Cel "${dc.key}" has both .f and .l — they're mutually exclusive.`);
    }
    if (!formulaFn) {
      throw new Error(
        `Cel "${dc.key}" has .f but no formula compiler is registered at fns key "f".`,
      );
    }
    cel.f = dc.f;
    cel._fn = formulaFn(dc.f) as Fn;
    cel.l = "f";
    cel.inputMap = cel.inputMap ?? {};
    const deps = formulaFn.extractDeps;
    if (deps) {
      for (const dep of deps(dc.f)) {
        if (!(dep in cel.inputMap)) cel.inputMap[dep] = dep;
      }
    }
  }
  return cel;
};

const deflate = (
  c: Cel,
  schemaToKey: Map<z.ZodType, SchemaKey>,
  tagRegistry: Map<TagKey, TagHandler>,
): DehydratedCel => {
  const dc: DehydratedCel = { key: c.key };
  if (c.v !== null && c.v !== undefined) {
    const handler = c.tag !== undefined ? tagRegistry.get(c.tag) : undefined;
    dc.v = handler?.serialize ? handler.serialize(c.v) : c.v;
  }
  if (c.l        !== undefined) dc.l        = c.l;
  if (c.inputMap !== undefined) dc.inputMap = c.inputMap;
  if (c.segment  !== undefined) dc.segment  = c.segment;
  if (c.schema   !== undefined) {
    const key = schemaToKey.get(c.schema);
    if (key !== undefined) dc.schema = key;
  }
  if (c.wave     !== undefined) dc.wave     = c.wave;
  if (c.locked   !== undefined) dc.locked   = c.locked;
  if (c.dynamic  !== undefined) dc.dynamic  = c.dynamic;
  if (c.f        !== undefined) dc.f        = c.f;
  if (c.tag      !== undefined) dc.tag      = c.tag;
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
  // Pass 1 — pull all segment-supplied metadata (schemas, fnMetaData,
  // schemaMetadata) into state. Doing this before fn install lets
  // segment-supplied locks gate the upcoming fn replacements; doing it
  // before cel inflation lets cels reference schemas declared in any
  // segment, not just earlier ones.
  for (const seg of segments) {
    if (seg.schemas) {
      const live = hydrateSchemas(seg.schemas);
      for (const [key, zodSchema] of live) {
        state.schemas.set(key, zodSchema);
      }
    }
    if (seg.fnMetaData) {
      for (const [key, meta] of Object.entries(seg.fnMetaData)) {
        state.fnMetadata.set(key, { ...meta, key });
      }
    }
    if (seg.schemaMetadata) {
      for (const [key, meta] of Object.entries(seg.schemaMetadata)) {
        state.schemaMetadata.set(key, { ...meta, key });
      }
    }
  }

  // Install user-supplied fns next, so cel inflation sees the final
  // registry — in particular, a host-replaced formula compiler at "f"
  // must be in place before any cel.f is compiled. Lock checks now see
  // both core and segment-supplied metadata.
  for (const fnMap of fns) {
    for (const [key, fn] of fnMap) {
      // Locked-fn enforcement: if an entry already exists at this key
      // and its metadata says locked, leave it alone. First install at
      // a key always wins, even if the incoming metadata is locked.
      if (state.fns.has(key) && state.fnMetadata.get(key)?.locked) continue;
      state.fns.set(key, fn);
    }
  }

  const formulaFn = state.fns.get("f");

  // Pass 2 — inflate cels with the final fn registry and schema set.
  for (const seg of segments) {
    for (const dc of seg.cels) {
      const existing = state.cels.get(dc.key);
      if (existing?.locked) continue;
      if (existing) disposeCel(existing, state.tagRegistry);
      state.cels.set(dc.key, inflate(dc, state.schemas, formulaFn));
    }
  }

  // Compile non-native kind lambdas via state.kindRegistry. Runs after
  // fns + fnMetadata are installed and after cels are inflated. Skips
  // cels that already have a cel._fn (e.g. formulas, compiled by
  // inflate). Throws if a cel needs a kind whose handler isn't
  // registered. Re-runs of hydrate fire any existing cel._dispose
  // before installing the new compilation.
  for (const cel of state.cels.values()) {
    if (!cel.l) continue;
    if (cel._fn) continue;
    const meta = state.fnMetadata.get(cel.l);
    if (!meta?.kind || meta.kind === "native") continue;
    const handler = state.kindRegistry.get(meta.kind);
    if (!handler) {
      throw new Error(
        `Cel "${cel.key}" uses lambda "${cel.l}" with kind "${meta.kind}" ` +
        `but no handler is registered in state.kindRegistry.`,
      );
    }
    if (cel._dispose) {
      try { cel._dispose(); } catch { /* swallow */ }
      cel._dispose = undefined;
    }
    const compiled = handler.compile({ cel, meta, state });
    cel._fn = compiled.fn;
    if (compiled.dispose) cel._dispose = compiled.dispose;
  }

  // Materialize cel._isChanged from schemaMetadata.diffFn. Runs after
  // fns are installed so the diff fn is guaranteed to be available.
  // Walks every cel — fine for small graphs; revisit if it gets hot.
  if (state.schemaMetadata.size > 0) {
    const keyOf = new Map<z.ZodType, SchemaKey>();
    for (const [k, zod] of state.schemas) keyOf.set(zod, k);
    for (const cel of state.cels.values()) {
      if (!cel.schema) continue;
      const schemaKey = keyOf.get(cel.schema);
      if (!schemaKey) continue;
      const diffFn = state.schemaMetadata.get(schemaKey)?.diffFn;
      if (!diffFn) continue;
      const fn = state.fns.get(diffFn);
      if (fn) cel._isChanged = fn;
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
    bucket.push(deflate(cel, schemaToKey, state.tagRegistry));
  }

  // No per-segment ownership in state for the metadata/schemas maps —
  // pin everything to the first emitted segment. Hydrate merges them
  // regardless of which segment carries them.
  const dehydratedSchemas = state.schemas.size > 0
    ? dehydrateSchemas(state.schemas)
    : undefined;
  const fnMetaData: Record<LambdaKey, LambdaMetadata> | undefined =
    state.fnMetadata.size > 0
      ? Object.fromEntries(state.fnMetadata)
      : undefined;
  const schemaMetadata = state.schemaMetadata.size > 0
    ? Object.fromEntries(state.schemaMetadata)
    : undefined;

  const segments: Segment[] = [];
  let pinned = false;
  for (const [key, cels] of bySegment) {
    const seg: Segment = { key, cels };
    if (!pinned) {
      if (dehydratedSchemas) seg.schemas = dehydratedSchemas;
      if (fnMetaData)        seg.fnMetaData = fnMetaData;
      if (schemaMetadata)    seg.schemaMetadata = schemaMetadata;
      pinned = true;
    }
    segments.push(seg);
  }
  return segments;
};
