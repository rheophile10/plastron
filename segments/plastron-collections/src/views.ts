import type { Column, Matrix, Table } from "./types.js";

// ========================================================================
// View helpers — read-only accessors and zero-copy slices.
//
// `index` and `matIndex` return scalars; `slice` and `tableColumn`
// return references that share the parent's underlying buffer.
// Mutating through a returned view changes the parent. This is the
// typed-array contract — slice() on a TypedArray is a copy in JS,
// but `subarray()` is a view; we use `subarray` here because the
// whole point is to avoid copying.
//
// Helpers themselves never mutate. They never bump gen. If the caller
// wants to mutate-then-publish, that's a separate code path (allocate
// a fresh Column from the slice, bump gen on the result).
// ========================================================================

/** Read a single element. O(1). Bounds checking is delegated to the
 *  typed array (out-of-range returns undefined → NaN-on-coerce). */
export const index = (col: Column, i: number): number => col.data[i] as number;

/** Slice a contiguous range. O(1) — returns a view into the same
 *  buffer, NOT a copy. Caller must not mutate the returned typed
 *  array unless they own the parent.
 *
 *  `end` defaults to `col.length`. Out-of-range indices are clamped
 *  by `subarray`. The returned Column inherits dtype and starts at
 *  `gen: 0` — slices are views, but the gen counter belongs to the
 *  envelope, not the buffer. Downstream cels treat a sliced Column
 *  as "freshly built" (gen 0) until something bumps it. */
export const slice = (col: Column, start: number, end?: number): Column => {
  const stop = end ?? col.length;
  const view = col.data.subarray(start, stop) as Column["data"];
  return { data: view, dtype: col.dtype, length: view.length, gen: 0 };
};

/** Read a single matrix element by [row, col, ...] coordinates.
 *  Row-major flatten: index = sum_i (coord_i * stride_i) where
 *  stride_i = product(shape[i+1:]). Bounds checks live in the typed
 *  array — passing an OOB coord returns NaN (or the typed-array
 *  coerce of `undefined`). */
export const matIndex = (m: Matrix, ...coords: number[]): number => {
  if (coords.length !== m.shape.length) {
    throw new Error(
      `matIndex: matrix has rank ${m.shape.length} but ` +
      `${coords.length} coordinates were given.`,
    );
  }
  let flat = 0;
  let stride = 1;
  for (let i = m.shape.length - 1; i >= 0; i--) {
    flat += coords[i]! * stride;
    stride *= m.shape[i]!;
  }
  return m.data[flat] as number;
};

/** Pick one column out of a table by name. Returns the existing
 *  Column envelope, NOT a copy. Throws if the name isn't present —
 *  silent undefined on a missing column is the wrong default for
 *  numerical code. */
export const tableColumn = (t: Table, name: string): Column => {
  const col = t.columns[name];
  if (!col) {
    throw new Error(
      `tableColumn: column "${name}" not in table. ` +
      `Available: ${Object.keys(t.columns).join(", ") || "(none)"}.`,
    );
  }
  return col;
};
