// ========================================================================
// columnSlotAccessor — SlotAccessor for cels carrying Column / Table /
// Matrix envelopes (cel.tag === "buffer").
//
// Dispatches by source-value shape since the same tag covers all three
// envelope types. Mutation strategy depends on the kind:
//
//   • Column — typed-array-backed; mutate `data[slot]` in place and
//     bump `gen`. Returns the same envelope reference so the kernel
//     knows to fire the cascade from the source key without re-
//     installing the value.
//
//   • Matrix — same as Column, but `slot` is a coordinate vector and
//     we flatten via row-major index.
//
//   • Table — slot is a column NAME (string). Replacing one column is
//     a shallow-clone of `columns` plus a gen bump. Returned as a new
//     envelope reference so the kernel routes the source through the
//     normal set path.
//
// Validation reports out-of-range slots up front. Hydrate calls this
// to surface dangling slot references before they corrupt the source.
// ========================================================================

import type { CelRef, SlotAccessor } from "../../../plastron/src/index.js";
import type { Column, Matrix, Table } from "./types.js";

const isMatrix = (v: unknown): v is Matrix =>
  !!v
  && typeof v === "object"
  && "data" in (v as object)
  && "shape" in (v as object);

const isTable = (v: unknown): v is Table =>
  !!v
  && typeof v === "object"
  && "columns" in (v as object)
  && !("data" in (v as object));

const isColumn = (v: unknown): v is Column =>
  !!v
  && typeof v === "object"
  && "data" in (v as object)
  && "dtype" in (v as object)
  && "length" in (v as object)
  && !("shape" in (v as object));

// Row-major flatten — duplicated from views.ts to avoid the wrapper
// arity check, since the accessor receives slot as a number[].
const flattenMatrix = (m: Matrix, coords: number[]): number => {
  let flat = 0;
  let stride = 1;
  for (let i = m.shape.length - 1; i >= 0; i--) {
    flat += coords[i]! * stride;
    stride *= m.shape[i]!;
  }
  return flat;
};

export const columnSlotAccessor: SlotAccessor = {
  read: (src, slot) => {
    if (isColumn(src)) {
      // slot must be a number index.
      return src.data[slot as number];
    }
    if (isMatrix(src)) {
      // slot must be a number[] coordinate vector.
      const coords = slot as number[];
      const flat = flattenMatrix(src, coords);
      return src.data[flat];
    }
    if (isTable(src)) {
      // slot is a column name (string).
      return src.columns[slot as string];
    }
    throw new Error(
      `columnSlotAccessor.read: source isn't Column/Table/Matrix ` +
      `(slot=${JSON.stringify(slot)})`,
    );
  },

  write: (src, slot, value) => {
    if (isColumn(src)) {
      // In-place mutation + gen bump. Returns same ref so the kernel
      // skips wholesale-replace and just fires the cascade from the
      // source key.
      (src.data as unknown as { [k: number]: number })[slot as number] = value as number;
      src.gen++;
      return src;
    }
    if (isMatrix(src)) {
      const coords = slot as number[];
      const flat = flattenMatrix(src, coords);
      (src.data as unknown as { [k: number]: number })[flat] = value as number;
      src.gen++;
      return src;
    }
    if (isTable(src)) {
      // Slot is a column name — replace the whole column. Shallow-
      // clone columns map; bump gen on the new envelope.
      const cols = { ...src.columns, [slot as string]: value as Column };
      return { ...src, columns: cols, gen: src.gen + 1 };
    }
    throw new Error(
      `columnSlotAccessor.write: source isn't Column/Table/Matrix ` +
      `(slot=${JSON.stringify(slot)})`,
    );
  },

  validate: (src, slot: CelRef["slot"]) => {
    if (isColumn(src)) {
      if (typeof slot !== "number") return false;
      return slot >= 0 && slot < src.length;
    }
    if (isMatrix(src)) {
      if (!Array.isArray(slot)) return false;
      if (slot.length !== src.shape.length) return false;
      for (let i = 0; i < slot.length; i++) {
        if (slot[i]! < 0 || slot[i]! >= src.shape[i]!) return false;
      }
      return true;
    }
    if (isTable(src)) {
      if (typeof slot !== "string") return false;
      return slot in src.columns;
    }
    return false;
  },
};
