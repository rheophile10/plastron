import type { Fn, SegmentManifest, State } from "../../../plastron/src/index.js";
import {
  browserFileIoLambdas,
  STORE_FILE_LAMBDA, PARSE_ROWS_FROM_FILE_LAMBDA,
} from "./lambdas.js";

// ========================================================================
// segment: plastron-browser-file-io
//
// Generic browser-side file plumbing — pickers, drag/drop, downloads,
// and small CSV/JSON parse helpers. Companion to plastron-archive: this
// segment provides the entry/exit points (e.g. "let the user pick a
// .甲 file from disk") and produces/consumes Uint8Array; plastron-
// archive does the format work. The composition lives in the host
// (call pickFile → readAsBytes → importArchive).
//
// This package is browser-only. Helpers throw on first call when the
// runtime is missing document / File / Blob (Node, edge runtimes
// without DOM, server-side renderers that haven't loaded a polyfill).
// installBrowserFileIo itself doesn't probe — it just registers
// lambdas + a manifest via hydrate, all of which are environment-
// independent. Hosts that boot in Node and conditionally upgrade to a
// browser later can call it eagerly; hosts that boot in Node and stay
// there should not call it.
//
// The lambdas it ships:
//
//   storeFile          — File → { name, mime, size, lastModified, bytes }
//   parseRowsFromFile  — { file, format } → string[][] (csv) | unknown[][] (json)
//
// They cover the common "drop a file in, get something useful out"
// pipelines. For very large files, pair storeFile with a future
// plastron-idb segment so the cel holds an opaque blob handle and the
// bytes stream from IndexedDB on demand.
// ========================================================================

export const PLASTRON_BROWSER_FILE_IO_SEGMENT = "plastron-browser-file-io" as const;

export const plastronBrowserFileIoManifest: SegmentManifest = {
  segment: PLASTRON_BROWSER_FILE_IO_SEGMENT,
  version: "0.0.1",
  description:
    "Browser File API helpers — pickers, downloads, CSV/JSON parsing. Complements plastron-archive for browser entry/exit.",
  provides: {
    lambdas: [STORE_FILE_LAMBDA, PARSE_ROWS_FROM_FILE_LAMBDA],
    celSegments: [PLASTRON_BROWSER_FILE_IO_SEGMENT],
  },
};

// ── Helpers (browser-only at first call) ──
export { pickFile, pickFileFromDrop } from "./pick.js";
export type { PickFileOptions } from "./pick.js";
export { readAsBytes, readAsText } from "./read.js";
export { downloadBytes } from "./download.js";
export { parseCsv, parseJson } from "./parse.js";
export type { ParseCsvOptions, ParseJsonResult } from "./parse.js";
export { isBrowserEnvironment } from "./env.js";

// ── Lambda wrappers (sync registration; safe to call in any env) ──
export {
  storeFile, parseRowsFromFile, browserFileIoLambdas,
  STORE_FILE_LAMBDA, PARSE_ROWS_FROM_FILE_LAMBDA,
} from "./lambdas.js";
export type {
  StoredFile, ParseRowsFromFileInput, ParseRowsFormat,
} from "./lambdas.js";

/** Install the plastron-browser-file-io lambdas onto an existing State.
 *
 *  Routes through `state.fns.get("hydrate")` so the install path
 *  matches sibling segments (plastron-dom, plastron-pdf, …). Hydrate
 *  applies its standard "lock-metadata wins" rule for the registered
 *  lambdas and records the manifest in `state.segments` after a
 *  successful precompute pass. The segment carries no cels (it ships
 *  helpers + lambda registrations only), so the cels list is empty and
 *  precompute is a near no-op.
 *
 *  This helper is sync and environment-agnostic — it doesn't probe for
 *  a browser. The registered lambdas themselves throw on first call in
 *  a non-browser environment via the standard `requireBrowser` guard.
 *
 *  Hosts that prefer to bundle this segment into a larger hydrate call
 *  (e.g. when booting many segments at once) can skip this helper and
 *  pass the manifest + lambda map directly:
 *
 *    hydrate(state, [{
 *      key: PLASTRON_BROWSER_FILE_IO_SEGMENT,
 *      cels: [],
 *      manifest: plastronBrowserFileIoManifest,
 *    }], [browserFileIoLambdas()]);
 */
export const installBrowserFileIo = (state: State): void => {
  const hydrate = state.fns.get("hydrate") as Fn;
  hydrate(
    state,
    [{
      key: PLASTRON_BROWSER_FILE_IO_SEGMENT,
      cels: [],
      manifest: plastronBrowserFileIoManifest,
    }],
    [browserFileIoLambdas()],
  );
};
