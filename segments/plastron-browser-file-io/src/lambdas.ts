// ========================================================================
// Lambda wrappers — register these in state.fns so cels can produce
// "stored file" and "parsed rows" values from a File reference.
//
// Why two lambdas instead of fold-into-one:
//
//   • storeFile turns a File reference (e.g. set on an input cel from a
//     pickFile() resolution) into a CelValueRepresentation that round-
//     trips through dehydrate. The resulting object holds bytes, so
//     small files (< few MB) sit comfortably in the cel graph; very
//     large files should be paired with plastron-idb (TODO when it
//     ships) so the cel holds an opaque blob handle and the bytes
//     stream from IndexedDB on demand.
//
//   • parseRowsFromFile is the convenience composition — it takes a
//     File and a format hint, reads as text, parses, and returns rows.
//     Hosts that want bytes-only (e.g. to hand to plastron-archive's
//     importArchive) should use storeFile and pull .bytes off the
//     result.
// ========================================================================

import type { Fn, LambdaKey } from "../../../plastron/src/index.js";
import { readAsBytes, readAsText } from "./read.js";
import { parseCsv, parseJson, type ParseCsvOptions } from "./parse.js";

export const STORE_FILE_LAMBDA       = "storeFile" as const;
export const PARSE_ROWS_FROM_FILE_LAMBDA = "parseRowsFromFile" as const;

/** CelValueRepresentation produced by the storeFile lambda. The bytes
 *  field is a Uint8Array; for very large files, host code should pair
 *  this with a blob-handle storage segment (e.g. plastron-idb when it
 *  ships) and store an opaque handle on the cel instead. */
export interface StoredFile {
  name: string;
  mime: string;
  size: number;
  /** ISO-8601 timestamp, or null if the File didn't carry a lastModified. */
  lastModified: string | null;
  bytes: Uint8Array;
}

const isFile = (x: unknown): x is File =>
  typeof File !== "undefined" && x instanceof File;

const isBlob = (x: unknown): x is Blob =>
  typeof Blob !== "undefined" && x instanceof Blob;

export const storeFile: Fn = async (input: unknown): Promise<StoredFile | null> => {
  // Accept either a bare File (the natural shape from pickFile) or
  // { file: File } (the convention for inputMap-driven cels). Returning
  // null when the upstream is empty lets a cel chain start with no file
  // selected and not crash on the first cycle.
  let file: unknown = input;
  if (input && typeof input === "object" && "file" in input) {
    file = (input as { file: unknown }).file;
  }
  if (file == null) return null;
  if (!isFile(file) && !isBlob(file)) {
    throw new Error("storeFile: input must be a File or Blob (or { file })");
  }

  const bytes = await readAsBytes(file);
  const name = isFile(file) ? file.name : "blob";
  const lastModified = isFile(file) && file.lastModified
    ? new Date(file.lastModified).toISOString()
    : null;

  return {
    name,
    mime: file.type || "application/octet-stream",
    size: file.size,
    lastModified,
    bytes,
  };
};

export type ParseRowsFormat = "csv" | "json";

export interface ParseRowsFromFileInput {
  file: File | Blob;
  format: ParseRowsFormat;
  /** Forwarded to readAsText. Default utf-8. */
  encoding?: string;
  /** Forwarded to parseCsv when format is "csv". */
  csv?: ParseCsvOptions;
}

/** Read a file and parse its contents as rows.
 *
 *   • format "csv" — returns string[][]
 *   • format "json" — expects either an array of arrays (returned as-is)
 *     or an array of objects (returned with a synthetic header row of
 *     keys followed by value rows). Anything else throws.
 *
 *  Returns null when input.file is null/undefined — same start-empty
 *  ergonomics as storeFile. */
export const parseRowsFromFile: Fn = async (
  input: ParseRowsFromFileInput | null | undefined,
): Promise<unknown[][] | null> => {
  if (!input || input.file == null) return null;

  const text = await readAsText(input.file, input.encoding);

  if (input.format === "csv") {
    return parseCsv(text, input.csv);
  }
  if (input.format === "json") {
    const parsed = parseJson(text);
    if (!parsed.ok) throw parsed.error;
    return jsonToRows(parsed.value);
  }
  throw new Error(`parseRowsFromFile: unknown format ${JSON.stringify(input.format)}`);
};

const jsonToRows = (value: unknown): unknown[][] => {
  if (!Array.isArray(value)) {
    throw new Error("parseRowsFromFile (json): expected a top-level array");
  }
  if (value.length === 0) return [];

  // Detect array-of-arrays vs array-of-objects from the first element.
  // Mixed shapes throw rather than silently coercing.
  const first = value[0];
  if (Array.isArray(first)) {
    for (const row of value) {
      if (!Array.isArray(row)) {
        throw new Error("parseRowsFromFile (json): mixed row shapes in array");
      }
    }
    return value as unknown[][];
  }
  if (first && typeof first === "object") {
    // Build the header from the union of keys across all objects, in
    // insertion order of first appearance. This keeps row width
    // consistent when later objects introduce new keys, which is the
    // useful behaviour for downstream tabular code.
    const headerSet = new Map<string, true>();
    for (const obj of value) {
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        throw new Error("parseRowsFromFile (json): mixed row shapes in array");
      }
      for (const k of Object.keys(obj)) headerSet.set(k, true);
    }
    const header = Array.from(headerSet.keys());
    const rows: unknown[][] = [header];
    for (const obj of value) {
      const row: unknown[] = [];
      for (const k of header) row.push((obj as Record<string, unknown>)[k] ?? null);
      rows.push(row);
    }
    return rows;
  }
  throw new Error("parseRowsFromFile (json): top-level array elements must be arrays or objects");
};

/** Map of all lambdas this segment provides, in the shape hydrate
 *  expects: `Map<LambdaKey, Fn>`. Use `installBrowserFileIo` to
 *  register them in one call, or merge into your own fns map. */
export const browserFileIoLambdas = (): Map<LambdaKey, Fn> => new Map<LambdaKey, Fn>([
  [STORE_FILE_LAMBDA,            storeFile],
  [PARSE_ROWS_FROM_FILE_LAMBDA,  parseRowsFromFile],
]);
