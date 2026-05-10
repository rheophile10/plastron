// ========================================================================
// Core envelope types — Column, Table, Matrix.
//
// Each envelope wraps a typed-array buffer (or a Record of columns, in
// Table's case) and carries a generation counter. The kernel's
// change-detection hook reads `gen`: equal gen ⇒ unchanged, no
// downstream re-fire. Bumping `gen` is the only signal that an in-place
// mutation occurred. Helpers in this package always allocate fresh
// buffers and start at gen 0; operator lambdas allocate fresh outputs
// and bump gen on every fire (see ops.ts).
//
// Cells holding any of these envelopes declare:
//   schema: ColumnSchema | TableSchema | MatrixSchema
//   tag:    "buffer"
//
// The schema wires up isChanged (gen-counter equality) plus a
// byteLength estimator so plastron's perf-tracking pass reports
// accurate sizes. The tag handler provides serialize / release
// semantics — CPU-only release is a no-op; the GPU backend overrides
// release later to free device buffers.
// ========================================================================

/** Numeric element type. Pick the smallest that fits — Uint8Array
 *  uses 8× less memory than Float64Array for boolean masks, and i16
 *  is plenty for many counter columns. */
export type Dtype = "f64" | "f32" | "i32" | "i16" | "u32" | "u16" | "u8";

/** Typed-array union covering every Dtype. */
export type ColumnArray =
  | Float64Array
  | Float32Array
  | Int32Array
  | Int16Array
  | Uint32Array
  | Uint16Array
  | Uint8Array;

export interface Column {
  data: ColumnArray;
  dtype: Dtype;
  length: number;
  /** Bumped by every in-place mutation. The kernel's isChanged for
   *  ColumnSchema is `prev?.gen !== next?.gen`, so equal gen short-
   *  circuits downstream re-fire. */
  gen: number;
}

export interface Table {
  columns: Record<string, Column>;
  /** Number of rows. Cross-checked against every column.length at
   *  build time — `tableFrom` throws if columns disagree. */
  length: number;
  gen: number;
}

export interface Matrix {
  data: Float64Array | Float32Array;
  dtype: "f64" | "f32";
  /** Row-major shape vector. `data.length` MUST equal product(shape).
   *  `matrixFrom` enforces this at build time. */
  shape: number[];
  gen: number;
}
