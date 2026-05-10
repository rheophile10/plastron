import type {
  Fn, LambdaKey, LambdaMetadata, SegmentManifest, State,
} from "../../../plastron/src/index.js";
import {
  BUFFER_TAG_KEY,
  COLUMN_BYTELENGTH_KEY, COLUMN_IS_CHANGED_KEY, COLUMN_SCHEMA_KEY,
  MATRIX_BYTELENGTH_KEY, MATRIX_IS_CHANGED_KEY, MATRIX_SCHEMA_KEY,
  TABLE_BYTELENGTH_KEY, TABLE_IS_CHANGED_KEY, TABLE_SCHEMA_KEY,
  columnByteLength, columnIsChanged, columnSchema,
  matrixByteLength, matrixIsChanged, matrixSchema,
  tableByteLength, tableIsChanged, tableSchema,
} from "./schemas.js";
import { bufferTag } from "./tag.js";
import { opFnMetadata, opFns } from "./ops.js";

// ========================================================================
// installCollections — one-call registration of every export this
// segment provides:
//
//   • Schemas for Column / Table / Matrix
//   • Schema metadata wiring isChanged + byteLength
//   • The isChanged + byteLength fns themselves
//   • Every operator lambda from ops.ts (with metadata)
//   • The "buffer" tag handler
//   • A SegmentManifest in state.segments
//
// Idempotent. Locked entries are not overwritten — host or another
// segment can lock keys to protect them. The segment manifest is
// only emitted once (subsequent calls leave it intact).
// ========================================================================

export const PLASTRON_COLLECTIONS_SEGMENT = "plastron-collections" as const;

export const plastronCollectionsManifest: SegmentManifest = {
  segment: PLASTRON_COLLECTIONS_SEGMENT,
  version: "0.0.1",
  description:
    "Helpers for packing scalar cels into dense typed-array structures " +
    "(Column, Table, Matrix) — schemas, gen-counter isChanged, byteLength " +
    "estimators, a starter operator lambda set, and a buffer tag handler.",
  provides: {
    schemas: [COLUMN_SCHEMA_KEY, TABLE_SCHEMA_KEY, MATRIX_SCHEMA_KEY],
    lambdas: [
      COLUMN_IS_CHANGED_KEY, TABLE_IS_CHANGED_KEY, MATRIX_IS_CHANGED_KEY,
      COLUMN_BYTELENGTH_KEY, TABLE_BYTELENGTH_KEY, MATRIX_BYTELENGTH_KEY,
      ...opFns.map(([k]) => k),
    ],
    tags: [BUFFER_TAG_KEY],
    celSegments: [PLASTRON_COLLECTIONS_SEGMENT],
  },
};

// ── fn map every install attaches ──────────────────────────────────────────

const buildInstallFns = (): Map<LambdaKey, Fn> => {
  const fns = new Map<LambdaKey, Fn>();
  // Schema-side fns.
  fns.set(COLUMN_IS_CHANGED_KEY, columnIsChanged);
  fns.set(TABLE_IS_CHANGED_KEY,  tableIsChanged);
  fns.set(MATRIX_IS_CHANGED_KEY, matrixIsChanged);
  fns.set(COLUMN_BYTELENGTH_KEY, columnByteLength as Fn);
  fns.set(TABLE_BYTELENGTH_KEY,  tableByteLength  as Fn);
  fns.set(MATRIX_BYTELENGTH_KEY, matrixByteLength as Fn);
  // Operator lambdas.
  for (const [k, f] of opFns) fns.set(k, f);
  return fns;
};

const lockedFn = (state: State, key: LambdaKey): boolean =>
  !!state.fnMetadata.get(key)?.locked && state.fns.has(key);

/** Install all collections-segment registrations into a state.
 *
 *  Idempotent — a second call leaves the (already-installed) entries
 *  alone. Locked entries are never overwritten.
 *
 *  After calling, cels can declare:
 *    schema: columnSchema | tableSchema | matrixSchema
 *    tag:    "buffer"
 *  and the kernel will auto-wire isChanged (gen-counter) onto each. */
export const installCollections = (state: State): void => {
  // ── Schemas + schema metadata (live Zod refs as Map keys) ─────────────
  if (!state.schemas.has(COLUMN_SCHEMA_KEY)) state.schemas.set(COLUMN_SCHEMA_KEY, columnSchema);
  if (!state.schemas.has(TABLE_SCHEMA_KEY))  state.schemas.set(TABLE_SCHEMA_KEY,  tableSchema);
  if (!state.schemas.has(MATRIX_SCHEMA_KEY)) state.schemas.set(MATRIX_SCHEMA_KEY, matrixSchema);

  if (!state.schemaMetadata.has(COLUMN_SCHEMA_KEY)) {
    state.schemaMetadata.set(COLUMN_SCHEMA_KEY, {
      key: COLUMN_SCHEMA_KEY,
      isChanged: COLUMN_IS_CHANGED_KEY,
      byteLength: COLUMN_BYTELENGTH_KEY,
    });
  }
  if (!state.schemaMetadata.has(TABLE_SCHEMA_KEY)) {
    state.schemaMetadata.set(TABLE_SCHEMA_KEY, {
      key: TABLE_SCHEMA_KEY,
      isChanged: TABLE_IS_CHANGED_KEY,
      byteLength: TABLE_BYTELENGTH_KEY,
    });
  }
  if (!state.schemaMetadata.has(MATRIX_SCHEMA_KEY)) {
    state.schemaMetadata.set(MATRIX_SCHEMA_KEY, {
      key: MATRIX_SCHEMA_KEY,
      isChanged: MATRIX_IS_CHANGED_KEY,
      byteLength: MATRIX_BYTELENGTH_KEY,
    });
  }

  // ── Tag handler ───────────────────────────────────────────────────────
  if (!state.tagRegistry.has(BUFFER_TAG_KEY)) {
    state.tagRegistry.set(BUFFER_TAG_KEY, bufferTag);
  }

  // ── Fns + fnMetadata via hydrate, so the segment manifest is
  //    recorded uniformly and downstream introspection (listSegments,
  //    findDependents) sees us. We pass an empty `cels: []` because
  //    this segment has no cels of its own.
  //
  //    Skip locked entries by filtering them out of the fn map before
  //    handing it to hydrate (hydrate refuses to overwrite locked
  //    entries; filtering preserves idempotency without depending on
  //    hydrate's specific error path).
  const allFns = buildInstallFns();
  const fns = new Map<LambdaKey, Fn>();
  for (const [k, f] of allFns) {
    if (lockedFn(state, k)) continue;
    fns.set(k, f);
  }

  // Carry metadata for each operator. Schema-fn metadata is minimal
  // (key + kind=native) — we don't bind it to inputSchema/outputSchema
  // because they're called on raw envelopes by the kernel, not as
  // user-facing lambdas.
  const fnMetaData: Record<LambdaKey, LambdaMetadata> = {};
  const addMeta = (key: LambdaKey, meta: LambdaMetadata): void => {
    if (lockedFn(state, key)) return;
    fnMetaData[key] = meta;
  };
  addMeta(COLUMN_IS_CHANGED_KEY, { key: COLUMN_IS_CHANGED_KEY, kind: "native" });
  addMeta(TABLE_IS_CHANGED_KEY,  { key: TABLE_IS_CHANGED_KEY,  kind: "native" });
  addMeta(MATRIX_IS_CHANGED_KEY, { key: MATRIX_IS_CHANGED_KEY, kind: "native" });
  addMeta(COLUMN_BYTELENGTH_KEY, { key: COLUMN_BYTELENGTH_KEY, kind: "native" });
  addMeta(TABLE_BYTELENGTH_KEY,  { key: TABLE_BYTELENGTH_KEY,  kind: "native" });
  addMeta(MATRIX_BYTELENGTH_KEY, { key: MATRIX_BYTELENGTH_KEY, kind: "native" });
  for (const meta of opFnMetadata) addMeta(meta.key, meta);

  // We don't pass schemas through hydrate's `schemas` field because
  // hydrate would call HydrateSchemas to inflate JSON-Schema → Zod.
  // Our schemas are unknown()-shaped live Zod values already, so
  // they're set directly on state.schemas above. The segment.schemas
  // wire format is for round-tripping JSON Schema documents; runtime
  // install goes direct.
  //
  // hydrate is required for manifest registration. Pass a single
  // segment with no cels but with the manifest, plus our fn map.
  // hydrate's manifest pass overwrites state.segments[key], which
  // matches our idempotency contract — the same manifest object
  // every call.
  const hydrate = state.fns.get("hydrate") as Fn;
  hydrate(
    state,
    [{
      key: PLASTRON_COLLECTIONS_SEGMENT,
      cels: [],
      fnMetaData,
      manifest: plastronCollectionsManifest,
    }],
    [fns],
  );
};
