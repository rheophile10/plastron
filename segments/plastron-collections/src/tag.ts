import type { TagHandler } from "../../../plastron/src/index.js";
import {
  columnByteLength, matrixByteLength, tableByteLength,
} from "./schemas.js";

// ========================================================================
// bufferTag — TagHandler for cels carrying Column / Table / Matrix.
//
// Three responsibilities:
//   • serialize — convert typed-array data to plain-array form so
//     the value JSON-roundtrips through dehydrate (and back through
//     hydrate, since Array-of-numbers is what the builder helpers
//     accept).
//   • release  — free any device-owned resources. CPU-only is a
//     no-op; the GPU backend overrides this with
//     `(v) => v.buffer.destroy()` when its device cel is non-null.
//   • byteLength — opaque-tag estimator. Tag estimator wins over
//     schema estimator when both are present (TagHandler.byteLength
//     contract from plastron/src/types/tags.ts). We dispatch by
//     shape since the same tag covers all three envelopes.
//
// Cells holding any of these envelopes declare `tag: "buffer"`. The
// schema declaration provides change detection; this tag declaration
// provides serialize / release / byteLength.
// ========================================================================

const isTypedArray = (v: unknown): v is ArrayLike<number> & ArrayBufferView => {
  return ArrayBuffer.isView(v) && !(v instanceof DataView);
};

const isMatrix = (v: unknown): boolean =>
  !!v
  && typeof v === "object"
  && "data" in (v as object)
  && "shape" in (v as object);

const isTable = (v: unknown): boolean =>
  !!v
  && typeof v === "object"
  && "columns" in (v as object)
  && !("data" in (v as object));

const isColumnLike = (v: unknown): boolean =>
  !!v
  && typeof v === "object"
  && "data" in (v as object)
  && "dtype" in (v as object)
  && "length" in (v as object)
  && !("shape" in (v as object));

export const bufferTag: TagHandler = {
  /** Convert typed-array data to plain arrays for JSON round-trip.
   *  Recognised shapes: a raw typed array, a Column / Matrix
   *  (top-level `data`), a Table (record of Columns). Anything else
   *  passes through unchanged — the host layer is welcome to declare
   *  `tag: "buffer"` for opaque values we don't natively serialize,
   *  and they'll just JSON-stringify with whatever default JS gives. */
  serialize: (v: unknown): unknown => {
    if (v == null) return v;
    if (v instanceof ArrayBuffer) {
      // Wrap in a Uint8Array view so we can iterate.
      return Array.from(new Uint8Array(v));
    }
    if (isTypedArray(v)) {
      return Array.from(v);
    }
    if (typeof v === "object" && v !== null) {
      // Column- or Matrix-shaped: top-level `data` is a typed array.
      const obj = v as Record<string, unknown>;
      if (isTypedArray(obj.data)) {
        return { ...obj, data: Array.from(obj.data as ArrayLike<number>) };
      }
      // Table-shaped: `columns` is a record of Columns.
      if (obj.columns && typeof obj.columns === "object") {
        const cols: Record<string, unknown> = {};
        for (const [name, c] of Object.entries(obj.columns as Record<string, unknown>)) {
          if (c && typeof c === "object" && isTypedArray((c as { data: unknown }).data)) {
            const cc = c as { data: ArrayLike<number> } & Record<string, unknown>;
            cols[name] = { ...cc, data: Array.from(cc.data) };
          } else {
            cols[name] = c;
          }
        }
        return { ...obj, columns: cols };
      }
    }
    return v;
  },

  /** Free resources held by the value. CPU-only: nothing to release.
   *  The hook is here so a GPU backend can override with
   *  `(v) => v.buffer.destroy()` (or similar) when its device cel is
   *  non-null. Errors are swallowed by the kernel (TagHandler
   *  contract), so a misbehaving release can't block teardown. */
  release: (_v: unknown): void => {
    // intentional no-op
  },

  /** Bytes consumed by the value. Dispatches by envelope shape so a
   *  single tag covers Column / Table / Matrix without forcing the
   *  schema metadata to win over the tag (in practice both are
   *  present and agree; the duplication is defensive). */
  byteLength: (v: unknown): number => {
    if (v == null) return 0;
    if (isTypedArray(v)) return v.byteLength;
    if (isMatrix(v)) return matrixByteLength(v);
    if (isTable(v)) return tableByteLength(v);
    if (isColumnLike(v)) return columnByteLength(v);
    return 0;
  },
};
