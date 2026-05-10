// ========================================================================
// plastron-collections — public surface.
//
// Two ways to use:
//
//   1. One-call install:
//      import { installCollections } from "plastron-collections";
//      installCollections(state);
//
//   2. Hand-pick:
//      import {
//        columnFrom, columnSum, columnSchema, bufferTag,
//      } from "plastron-collections";
//      state.schemas.set("plastronCollections:column", columnSchema);
//      state.tagRegistry.set("buffer", bufferTag);
//      state.fns.set("plastronCollections:columnSum", columnSum);
//
// Both lead to the same place. installCollections is the convenience
// surface; the individual exports give per-feature granularity.
// ========================================================================

// Core types.
export type { Column, ColumnArray, Dtype, Matrix, Table } from "./types.js";

// Builders.
export { columnFrom, matrixFrom, tableFrom } from "./builders.js";

// Views.
export { index, matIndex, slice, tableColumn } from "./views.js";

// Schemas + schema-side fns + key constants.
export {
  BUFFER_TAG_KEY,
  COLUMN_BYTELENGTH_KEY, COLUMN_IS_CHANGED_KEY, COLUMN_SCHEMA_KEY,
  MATRIX_BYTELENGTH_KEY, MATRIX_IS_CHANGED_KEY, MATRIX_SCHEMA_KEY,
  TABLE_BYTELENGTH_KEY, TABLE_IS_CHANGED_KEY, TABLE_SCHEMA_KEY,
  columnByteLength, columnIsChanged, columnSchema,
  matrixByteLength, matrixIsChanged, matrixSchema,
  tableByteLength, tableIsChanged, tableSchema,
} from "./schemas.js";

// Tag handler.
export { bufferTag } from "./tag.js";

// Slot accessor (used by ref cels) + consolidate helpers.
export { columnSlotAccessor } from "./refs.js";
export { consolidateInPlace, expandRefs } from "./consolidate.js";
export type { ConsolidateOptions } from "./consolidate.js";

// Operators + their key constants.
export {
  COLUMN_FILTER_KEY, COLUMN_MAP_KEY, COLUMN_SUM_KEY, COLUMN_ZIP_KEY,
  DOT_KEY, MATMUL_KEY, TABLE_PROJECT_KEY, TRANSPOSE_KEY,
  VEC_ADD_KEY, VEC_SCALE_KEY,
  columnFilter, columnMap, columnSum, columnZip,
  dot, matmul, opFnMetadata, opFns, tableProject, transpose,
  vecAdd, vecScale,
} from "./ops.js";

// Install + manifest.
export {
  PLASTRON_COLLECTIONS_SEGMENT, installCollections, plastronCollectionsManifest,
} from "./install.js";
