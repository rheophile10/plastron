import { z } from "zod";
import type { Column, Matrix, Table } from "./types.js";

// ========================================================================
// Schemas + lambda key constants for the three envelopes.
//
// Schemas are deliberately loose (`z.unknown()`-equivalent shape).
// They exist so the kernel can:
//   • use the live ZodType as a Map key in state.schemas
//   • look up SchemaMetadata.isChanged → register a gen-counter
//     comparator on every cel declaring this schema
//   • look up SchemaMetadata.byteLength → an estimator wired into
//     the perf-tracking accountant
//
// Validation strictness is intentionally minimal — these envelopes
// are trusted output of the builder helpers / operator lambdas. A
// strict schema would reject typed-array values (z.instanceof
// targets a single constructor at a time, and we span seven), force
// us to special-case each Dtype, and slow precompute. The byteLength
// estimator and isChanged comparator are the load-bearing surface;
// the schema body is just a recognizable handle.
// ========================================================================

export const COLUMN_SCHEMA_KEY = "plastronCollections:column" as const;
export const TABLE_SCHEMA_KEY  = "plastronCollections:table"  as const;
export const MATRIX_SCHEMA_KEY = "plastronCollections:matrix" as const;

export const COLUMN_IS_CHANGED_KEY = "plastronCollections:columnIsChanged" as const;
export const TABLE_IS_CHANGED_KEY  = "plastronCollections:tableIsChanged"  as const;
export const MATRIX_IS_CHANGED_KEY = "plastronCollections:matrixIsChanged" as const;

export const COLUMN_BYTELENGTH_KEY = "plastronCollections:columnByteLength" as const;
export const TABLE_BYTELENGTH_KEY  = "plastronCollections:tableByteLength"  as const;
export const MATRIX_BYTELENGTH_KEY = "plastronCollections:matrixByteLength" as const;

export const BUFFER_TAG_KEY = "buffer" as const;

// ── Live Zod schemas (used as Map keys) ────────────────────────────────────

export const columnSchema: z.ZodType = z.unknown();
export const tableSchema:  z.ZodType = z.unknown();
export const matrixSchema: z.ZodType = z.unknown();

// ── Gen-counter isChanged ──────────────────────────────────────────────────
//
// Reference equality short-circuit + gen comparison. Cells that build
// a fresh envelope each fire (operator lambdas, builder helpers
// inside a render lambda) bump gen to signal change; cells that
// pass-through the same envelope (no work done) carry the same
// reference and same gen — kernel skips the downstream re-fire.

export const columnIsChanged = (prev: unknown, next: unknown): boolean => {
  if (prev === next) return false;
  const a = prev as Column | null | undefined;
  const b = next as Column | null | undefined;
  if (!a || !b) return a !== b;
  return a.gen !== b.gen;
};

export const tableIsChanged = (prev: unknown, next: unknown): boolean => {
  if (prev === next) return false;
  const a = prev as Table | null | undefined;
  const b = next as Table | null | undefined;
  if (!a || !b) return a !== b;
  return a.gen !== b.gen;
};

export const matrixIsChanged = (prev: unknown, next: unknown): boolean => {
  if (prev === next) return false;
  const a = prev as Matrix | null | undefined;
  const b = next as Matrix | null | undefined;
  if (!a || !b) return a !== b;
  return a.gen !== b.gen;
};

// ── byteLength estimators ──────────────────────────────────────────────────
//
// Matches the perf-tracking pass's contract. Each returns
// approximate bytes consumed by the value — typed-array bytes are
// exact (BYTES_PER_ELEMENT * length); object overhead and dtype/key
// slots are approximated with the same fuzzy constants used by
// plastron-dom's vnode estimator. This is a relative reporting tool,
// not a heap auditor.

const ENVELOPE_OVERHEAD = 64; // hidden class + property slots for the wrapper
const STRING_BYTES_PER_CHAR = 2; // UTF-16 in V8

const stringBytes = (s: string): number => STRING_BYTES_PER_CHAR * s.length;

export const columnByteLength = (v: unknown): number => {
  if (v == null) return 0;
  const c = v as Column;
  if (!c.data || typeof c.data.byteLength !== "number") return ENVELOPE_OVERHEAD;
  return ENVELOPE_OVERHEAD + c.data.byteLength + stringBytes(c.dtype);
};

export const tableByteLength = (v: unknown): number => {
  if (v == null) return 0;
  const t = v as Table;
  let s = ENVELOPE_OVERHEAD;
  if (!t.columns) return s;
  for (const [name, col] of Object.entries(t.columns)) {
    s += stringBytes(name);
    s += columnByteLength(col);
  }
  return s;
};

export const matrixByteLength = (v: unknown): number => {
  if (v == null) return 0;
  const m = v as Matrix;
  let s = ENVELOPE_OVERHEAD;
  if (m.data && typeof m.data.byteLength === "number") s += m.data.byteLength;
  if (m.dtype) s += stringBytes(m.dtype);
  if (Array.isArray(m.shape)) s += 8 * m.shape.length; // fuzzy: number per dim
  return s;
};
