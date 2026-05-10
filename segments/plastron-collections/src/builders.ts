import type { Column, ColumnArray, Dtype, Matrix, Table } from "./types.js";

// ========================================================================
// Builders — pure, sync, side-effect-free factory functions.
//
// Each helper:
//   • Allocates a fresh typed array (no shared buffers across calls).
//   • Copies inputs into the new buffer.
//   • Returns an envelope at gen 0.
//
// They're safe to call from inside any lambda. The kernel doesn't
// know about Column/Table/Matrix; the cel author wraps a render
// lambda's return in one of these and declares the matching schema.
// ========================================================================

const TYPED_ARRAY_CTORS: Record<Dtype, new (length: number) => ColumnArray> = {
  f64: Float64Array,
  f32: Float32Array,
  i32: Int32Array,
  i16: Int16Array,
  u32: Uint32Array,
  u16: Uint16Array,
  u8:  Uint8Array,
};

const allocTyped = (dtype: Dtype, length: number): ColumnArray => {
  const Ctor = TYPED_ARRAY_CTORS[dtype];
  if (!Ctor) {
    throw new Error(`plastron-collections: unknown dtype "${dtype}".`);
  }
  return new Ctor(length);
};

/** Build a Column from an array of numbers. The default dtype is
 *  `f64` — the safest pick for arbitrary numeric data (no integer
 *  rounding, no NaN-on-overflow surprises). Pick a tighter dtype
 *  when you know the value range; mismatched values are coerced by
 *  the typed-array constructor (e.g. negative numbers stored in u8
 *  wrap silently — that's the typed-array contract, not a bug we
 *  mask). */
export const columnFrom = (
  values: ReadonlyArray<number>,
  dtype: Dtype = "f64",
): Column => {
  const length = values.length;
  const data = allocTyped(dtype, length);
  for (let i = 0; i < length; i++) data[i] = values[i]!;
  return { data, dtype, length, gen: 0 };
};

/** Build a Table from a record of named columns. Each entry may be
 *  either a pre-built Column (used as-is) or an array of numbers
 *  (passed through columnFrom with `defaultDtype`). All columns must
 *  have the same length; mismatch throws with a clear message
 *  identifying the offending column. */
export const tableFrom = (
  columns: Record<string, Column | ReadonlyArray<number>>,
  defaultDtype: Dtype = "f64",
): Table => {
  const built: Record<string, Column> = {};
  let length = -1;
  let pivotName = "";
  for (const [name, src] of Object.entries(columns)) {
    const col = isColumn(src) ? src : columnFrom(src, defaultDtype);
    if (length < 0) {
      length = col.length;
      pivotName = name;
    } else if (col.length !== length) {
      throw new Error(
        `tableFrom: column "${name}" has length ${col.length}, ` +
        `but column "${pivotName}" set the table length to ${length}. ` +
        `All columns must agree.`,
      );
    }
    built[name] = col;
  }
  if (length < 0) length = 0;
  return { columns: built, length, gen: 0 };
};

/** Build a Matrix from a 2D array of numbers (rows-of-columns).
 *  Stored row-major. Throws on ragged input (rows must all have the
 *  same width). Higher-rank tensors aren't built by this helper —
 *  use the Matrix interface directly with explicit `shape` if you
 *  need rank > 2. */
export const matrixFrom = (
  rows: ReadonlyArray<ReadonlyArray<number>>,
  dtype: "f64" | "f32" = "f64",
): Matrix => {
  const r = rows.length;
  const c = r > 0 ? rows[0]!.length : 0;
  for (let i = 1; i < r; i++) {
    if (rows[i]!.length !== c) {
      throw new Error(
        `matrixFrom: row ${i} has width ${rows[i]!.length}, ` +
        `but row 0 has width ${c}. Matrix must be rectangular.`,
      );
    }
  }
  const total = r * c;
  const Ctor = dtype === "f32" ? Float32Array : Float64Array;
  const data = new Ctor(total);
  for (let i = 0; i < r; i++) {
    const row = rows[i]!;
    const base = i * c;
    for (let j = 0; j < c; j++) data[base + j] = row[j]!;
  }
  return { data, dtype, shape: [r, c], gen: 0 };
};

// ------------------------------------------------------------------------
// isColumn — duck-type check used by tableFrom to tell pre-built
// columns from raw arrays. Cheap and structural; we don't import the
// Column constructor (there isn't one) so a simple shape check is the
// right tool.
// ------------------------------------------------------------------------

const isColumn = (x: unknown): x is Column =>
  !!x
  && typeof x === "object"
  && !Array.isArray(x)
  && "data" in (x as object)
  && "dtype" in (x as object)
  && "length" in (x as object)
  && "gen" in (x as object);
