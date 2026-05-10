import type { Fn, LambdaMetadata } from "../../../plastron/src/index.js";
import type { Column, ColumnArray, Dtype, Matrix, Table } from "./types.js";
import {
  COLUMN_SCHEMA_KEY, MATRIX_SCHEMA_KEY, TABLE_SCHEMA_KEY,
} from "./schemas.js";

// ========================================================================
// Operator lambdas — the starter set the spec calls for. Each is a
// native `Fn` paired with `LambdaMetadata`. Hosts hand-pick them via
// the named exports or call `installCollections` to register all of
// them at once.
//
// Conventions every op follows:
//   • Allocates a fresh output buffer. Never reuses an input's
//     buffer (would defeat isChanged + introduce aliasing bugs).
//   • Bumps gen on the output (output starts at gen 1, since the
//     output represents "newly produced this fire").
//   • Throws with a clear message on shape mismatches. Silent
//     wrong-shape arithmetic is the worst kind of numerical bug.
//
// CPU implementations only. The GPU/WGSL backend is a separate
// task — its lambdas register under the same keys and shadow the
// CPU versions when the device cel is non-null.
// ========================================================================

// ── Lambda key constants ───────────────────────────────────────────────────

export const COLUMN_SUM_KEY     = "plastronCollections:columnSum"     as const;
export const COLUMN_MAP_KEY     = "plastronCollections:columnMap"     as const;
export const COLUMN_FILTER_KEY  = "plastronCollections:columnFilter"  as const;
export const COLUMN_ZIP_KEY     = "plastronCollections:columnZip"     as const;
export const VEC_ADD_KEY        = "plastronCollections:vecAdd"        as const;
export const VEC_SCALE_KEY      = "plastronCollections:vecScale"      as const;
export const DOT_KEY            = "plastronCollections:dot"           as const;
export const MATMUL_KEY         = "plastronCollections:matmul"        as const;
export const TRANSPOSE_KEY      = "plastronCollections:transpose"     as const;
export const TABLE_PROJECT_KEY  = "plastronCollections:tableProject"  as const;

// ── Helpers ────────────────────────────────────────────────────────────────

const TYPED_ARRAY_CTORS: Record<Dtype, new (length: number) => ColumnArray> = {
  f64: Float64Array,
  f32: Float32Array,
  i32: Int32Array,
  i16: Int16Array,
  u32: Uint32Array,
  u16: Uint16Array,
  u8:  Uint8Array,
};

const allocLike = (col: Column, length: number = col.length): ColumnArray =>
  new TYPED_ARRAY_CTORS[col.dtype](length);

const allocLikeMatrix = (m: Matrix, length: number): Float64Array | Float32Array =>
  m.dtype === "f32" ? new Float32Array(length) : new Float64Array(length);

const isMatrix = (v: unknown): v is Matrix =>
  !!v
  && typeof v === "object"
  && "data" in (v as object)
  && "shape" in (v as object);

const isColumn = (v: unknown): v is Column =>
  !!v
  && typeof v === "object"
  && "data" in (v as object)
  && "dtype" in (v as object)
  && "length" in (v as object)
  && !("shape" in (v as object));

// ── Operators ──────────────────────────────────────────────────────────────

/** Sum every element of a column. */
export const columnSum: Fn = ({ col }: { col: Column }): number => {
  let s = 0;
  const d = col.data;
  const n = col.length;
  for (let i = 0; i < n; i++) s += d[i] as number;
  return s;
};

/** Apply a scalar fn elementwise. The `fn` argument is a plain JS
 *  function (typically passed via the upstream cel's value or
 *  closed over in the caller). Output dtype matches input dtype. */
export const columnMap: Fn = (
  { col, fn }: { col: Column; fn: (x: number, i: number) => number },
): Column => {
  const out = allocLike(col);
  const d = col.data;
  const n = col.length;
  for (let i = 0; i < n; i++) out[i] = fn(d[i] as number, i);
  return { data: out, dtype: col.dtype, length: n, gen: 1 };
};

/** Boolean mask: keep elements where mask[i] != 0. Output length is
 *  the popcount of the mask. Mask must match column length. */
export const columnFilter: Fn = (
  { col, mask }: { col: Column; mask: Column },
): Column => {
  if (mask.length !== col.length) {
    throw new Error(
      `columnFilter: mask length ${mask.length} != col length ${col.length}.`,
    );
  }
  // Two-pass: count, then fill. Cheaper than push-into-array + copy.
  let kept = 0;
  const m = mask.data;
  for (let i = 0; i < mask.length; i++) if ((m[i] as number) !== 0) kept++;
  const out = allocLike(col, kept);
  const d = col.data;
  let j = 0;
  for (let i = 0; i < col.length; i++) {
    if ((m[i] as number) !== 0) out[j++] = d[i] as number;
  }
  return { data: out, dtype: col.dtype, length: kept, gen: 1 };
};

/** Elementwise binary op between two columns. Output dtype follows
 *  `a` (the left operand). Lengths must match. */
export const columnZip: Fn = (
  { a, b, op }: { a: Column; b: Column; op: "add" | "sub" | "mul" | "div" },
): Column => {
  if (a.length !== b.length) {
    throw new Error(`columnZip: length ${a.length} != ${b.length}.`);
  }
  const out = allocLike(a);
  const da = a.data;
  const db = b.data;
  const n = a.length;
  switch (op) {
    case "add": for (let i = 0; i < n; i++) out[i] = (da[i] as number) + (db[i] as number); break;
    case "sub": for (let i = 0; i < n; i++) out[i] = (da[i] as number) - (db[i] as number); break;
    case "mul": for (let i = 0; i < n; i++) out[i] = (da[i] as number) * (db[i] as number); break;
    case "div": for (let i = 0; i < n; i++) out[i] = (da[i] as number) / (db[i] as number); break;
    default:
      throw new Error(`columnZip: unknown op "${String(op)}".`);
  }
  return { data: out, dtype: a.dtype, length: n, gen: 1 };
};

/** a + b for two Columns or two Matrices. Shapes must match. */
export const vecAdd: Fn = (
  { a, b }: { a: Column | Matrix; b: Column | Matrix },
): Column | Matrix => {
  if (isMatrix(a) && isMatrix(b)) {
    if (!shapesEqual(a.shape, b.shape)) {
      throw new Error(`vecAdd: matrix shape mismatch [${a.shape}] vs [${b.shape}].`);
    }
    const out = allocLikeMatrix(a, a.data.length);
    for (let i = 0; i < a.data.length; i++) out[i] = (a.data[i] as number) + (b.data[i] as number);
    return { data: out, dtype: a.dtype, shape: [...a.shape], gen: 1 };
  }
  if (isColumn(a) && isColumn(b)) {
    return columnZip({ a, b, op: "add" }) as Column;
  }
  throw new Error("vecAdd: operands must both be Column or both be Matrix.");
};

/** Scale each element by k. */
export const vecScale: Fn = (
  { v, k }: { v: Column | Matrix; k: number },
): Column | Matrix => {
  if (isMatrix(v)) {
    const out = allocLikeMatrix(v, v.data.length);
    for (let i = 0; i < v.data.length; i++) out[i] = (v.data[i] as number) * k;
    return { data: out, dtype: v.dtype, shape: [...v.shape], gen: 1 };
  }
  if (isColumn(v)) {
    const out = allocLike(v);
    const d = v.data;
    for (let i = 0; i < v.length; i++) out[i] = (d[i] as number) * k;
    return { data: out, dtype: v.dtype, length: v.length, gen: 1 };
  }
  throw new Error("vecScale: v must be Column or Matrix.");
};

/** Dot product of two columns. */
export const dot: Fn = ({ a, b }: { a: Column; b: Column }): number => {
  if (a.length !== b.length) {
    throw new Error(`dot: length ${a.length} != ${b.length}.`);
  }
  let s = 0;
  const da = a.data;
  const db = b.data;
  const n = a.length;
  for (let i = 0; i < n; i++) s += (da[i] as number) * (db[i] as number);
  return s;
};

/** Matrix multiply. Both matrices must be rank 2 with `a.cols ===
 *  b.rows`. Output dtype follows `a`. Naive O(MNK) loop — adequate
 *  for the moderate sizes the userland CPU path is for; the GPU
 *  backend will replace it for large matmuls. */
export const matmul: Fn = ({ a, b }: { a: Matrix; b: Matrix }): Matrix => {
  if (a.shape.length !== 2 || b.shape.length !== 2) {
    throw new Error(`matmul: expected rank-2 matrices, got [${a.shape}] x [${b.shape}].`);
  }
  const [m, k] = a.shape as [number, number];
  const [k2, n] = b.shape as [number, number];
  if (k !== k2) {
    throw new Error(`matmul: inner dims mismatch a.cols=${k} vs b.rows=${k2}.`);
  }
  const out = allocLikeMatrix(a, m * n);
  const da = a.data;
  const db = b.data;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let p = 0; p < k; p++) {
        s += (da[i * k + p] as number) * (db[p * n + j] as number);
      }
      out[i * n + j] = s;
    }
  }
  return { data: out, dtype: a.dtype, shape: [m, n], gen: 1 };
};

/** Transpose a rank-2 matrix. */
export const transpose: Fn = ({ m }: { m: Matrix }): Matrix => {
  if (m.shape.length !== 2) {
    throw new Error(`transpose: expected rank-2 matrix, got [${m.shape}].`);
  }
  const [r, c] = m.shape as [number, number];
  const out = allocLikeMatrix(m, r * c);
  const d = m.data;
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      out[j * r + i] = d[i * c + j] as number;
    }
  }
  return { data: out, dtype: m.dtype, shape: [c, r], gen: 1 };
};

/** Pick a subset of columns from a table by name. The picked
 *  Column envelopes are reused (zero-copy projection). The
 *  resulting Table is a fresh envelope at gen 1. Missing names
 *  throw with the offending key listed. */
export const tableProject: Fn = (
  { t, names }: { t: Table; names: ReadonlyArray<string> },
): Table => {
  const out: Record<string, Column> = {};
  for (const name of names) {
    const col = t.columns[name];
    if (!col) {
      throw new Error(
        `tableProject: column "${name}" not in table. ` +
        `Available: ${Object.keys(t.columns).join(", ") || "(none)"}.`,
      );
    }
    out[name] = col;
  }
  return { columns: out, length: t.length, gen: 1 };
};

// ── Helpers used above ─────────────────────────────────────────────────────

const shapesEqual = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

// ── Registry shapes ────────────────────────────────────────────────────────
//
// `opFns` and `opFnMetadata` are what installCollections imports.
// They're re-exported here so a host can install just a subset by
// hand (e.g. `state.fns.set(MATMUL_KEY, matmul)`) without going
// through installCollections.

export const opFns: ReadonlyArray<readonly [string, Fn]> = [
  [COLUMN_SUM_KEY,    columnSum],
  [COLUMN_MAP_KEY,    columnMap],
  [COLUMN_FILTER_KEY, columnFilter],
  [COLUMN_ZIP_KEY,    columnZip],
  [VEC_ADD_KEY,       vecAdd],
  [VEC_SCALE_KEY,     vecScale],
  [DOT_KEY,           dot],
  [MATMUL_KEY,        matmul],
  [TRANSPOSE_KEY,     transpose],
  [TABLE_PROJECT_KEY, tableProject],
];

export const opFnMetadata: ReadonlyArray<LambdaMetadata> = [
  { key: COLUMN_SUM_KEY,    kind: "native", inputSchema: COLUMN_SCHEMA_KEY                                  },
  { key: COLUMN_MAP_KEY,    kind: "native", inputSchema: COLUMN_SCHEMA_KEY, outputSchema: COLUMN_SCHEMA_KEY },
  { key: COLUMN_FILTER_KEY, kind: "native", inputSchema: COLUMN_SCHEMA_KEY, outputSchema: COLUMN_SCHEMA_KEY },
  { key: COLUMN_ZIP_KEY,    kind: "native", inputSchema: COLUMN_SCHEMA_KEY, outputSchema: COLUMN_SCHEMA_KEY },
  { key: VEC_ADD_KEY,       kind: "native"                                                                  },
  { key: VEC_SCALE_KEY,     kind: "native"                                                                  },
  { key: DOT_KEY,           kind: "native", inputSchema: COLUMN_SCHEMA_KEY                                  },
  { key: MATMUL_KEY,        kind: "native", inputSchema: MATRIX_SCHEMA_KEY, outputSchema: MATRIX_SCHEMA_KEY },
  { key: TRANSPOSE_KEY,     kind: "native", inputSchema: MATRIX_SCHEMA_KEY, outputSchema: MATRIX_SCHEMA_KEY },
  { key: TABLE_PROJECT_KEY, kind: "native", inputSchema: TABLE_SCHEMA_KEY,  outputSchema: TABLE_SCHEMA_KEY  },
];

// ── isChanged + byteLength fn registrations ────────────────────────────────
//
// These are not "operator" lambdas in the user-facing sense, but
// they ARE Fns that need to live in state.fns so the kernel can
// resolve schemaMetadata.isChanged / schemaMetadata.byteLength
// keys. installCollections registers them alongside the operators.
