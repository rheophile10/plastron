import type { z } from "zod";
import type {
  Cel, Compiler, DehydratedCel, Dehydrate, Fn, Hydrate,
  Key, LambdaKey, LambdaMetadata, SchemaKey,
  Segment, TagHandler, TagKey,
} from "../types/index.js";
import { precompute } from "./precompute.js";
import { dehydrateSchemas, hydrateSchemas } from "./schema-conversion.js";

// Compile a cel's source body (cel.f) via the compiler at
// state.fns.get(cel.l ?? "f"). Sets cel._fn, cel._dispose, and
// auto-wires cel.inputMap from the compiler's extractDeps if present.
// Stamps cel.l with the resolved compiler key so the cel reads
// consistently after hydrate. No-op when cel.f is unset.
//
// Throws if no compiler is registered at the resolved key — cels
// that ship with source MUST have their compiler available before
// hydrate inflates them.
export const compileCelBody = (cel: Cel, fns: Map<LambdaKey, Fn>): void => {
  if (cel.f === undefined) return;
  const compilerKey = cel.l ?? "f";
  const compiler = fns.get(compilerKey) as Compiler | undefined;
  if (!compiler) {
    throw new Error(
      `Cel "${cel.key}" has source but no compiler is registered at ` +
      `state.fns key "${compilerKey}".`,
    );
  }
  const compiled = compiler(cel.f);
  if (typeof compiled === "function") {
    cel._fn = compiled;
  } else {
    cel._fn = compiled.fn;
    if (compiled.dispose) cel._dispose = compiled.dispose;
  }
  cel.l = compilerKey;
  cel.inputMap = cel.inputMap ?? {};
  if (compiler.extractDeps) {
    for (const dep of compiler.extractDeps(cel.f)) {
      if (!(dep in cel.inputMap)) cel.inputMap[dep] = dep;
    }
  }
};

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
  fns: Map<LambdaKey, Fn>,
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
  if (dc.channel  !== undefined) cel.channel  = dc.channel;
  if (dc.f        !== undefined) {
    cel.f = dc.f;
    compileCelBody(cel, fns);
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
  if (c.channel  !== undefined) dc.channel  = c.channel;
  return dc;
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

  // Auto-compile shared-body lambdas declared via segment.fnMetaData
  // with both `source` and `kind` populated. Runs BEFORE cel inflation
  // so that cels referencing these lambdas via cel.l (no per-cel cel.f)
  // find them already registered in state.fns. Idempotent: skips
  // entries already installed in state.fns. Throws when a kind names a
  // compiler that isn't registered — surface the missing dependency at
  // hydrate rather than at first cascade.
  for (const [key, meta] of state.fnMetadata) {
    if (state.fns.has(key)) continue;
    if (!meta.source || !meta.kind || meta.kind === "native") continue;
    const compiler = state.fns.get(meta.kind) as Compiler | undefined;
    if (!compiler) {
      throw new Error(
        `Lambda "${key}" has kind "${meta.kind}" with source, but no ` +
        `compiler is registered at state.fns key "${meta.kind}".`,
      );
    }
    const compiled = compiler(meta.source);
    if (typeof compiled === "function") {
      state.fns.set(key, compiled);
    } else {
      state.fns.set(key, compiled.fn);
      if (compiled.dispose) state.fnDispose.set(key, compiled.dispose);
    }
  }

  // Pass 2 — inflate cels with the final fn registry and schema set.
  // compileCelBody handles per-cel cel.f compilation inside inflate.
  for (const seg of segments) {
    for (const dc of seg.cels) {
      const existing = state.cels.get(dc.key);
      if (existing?.locked) continue;
      if (existing) disposeCel(existing, state.tagRegistry);
      state.cels.set(dc.key, inflate(dc, state.schemas, state.fns));
    }
  }

  // Materialize cel._isChanged and cel._diffFn from schemaMetadata.
  // Runs after fns are installed so referenced fns are guaranteed
  // available. Walks every cel — fine for small graphs.
  if (state.schemaMetadata.size > 0) {
    const keyOf = new Map<z.ZodType, SchemaKey>();
    for (const [k, zod] of state.schemas) keyOf.set(zod, k);
    for (const cel of state.cels.values()) {
      if (!cel.schema) continue;
      const schemaKey = keyOf.get(cel.schema);
      if (!schemaKey) continue;
      const meta = state.schemaMetadata.get(schemaKey);
      if (!meta) continue;
      if (meta.isChanged) {
        const fn = state.fns.get(meta.isChanged);
        if (fn) cel._isChanged = fn;
      }
      if (meta.diff) {
        const fn = state.fns.get(meta.diff);
        if (fn) cel._diffFn = fn;
      }
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
