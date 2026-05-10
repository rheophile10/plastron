// ============================================================================
// plastron-idb — IndexedDB persistence for plastron.
//
// Three things ship together:
//
//   1. A persistence channel ("idb") — debounced per-cel write-out.
//      Cels declare `channel: "idb"` and the channel coalesces value
//      changes within a 100 ms window into one transaction.
//
//   2. A blob-handle tag ("idb-blob") — opaque large values stored in
//      the "blobs" object store. The cel holds a small JSON-shaped
//      handle ({ idbKey, size, mime?, sha256? }); the actual bytes
//      live in IDB. The tag's release deletes the IDB row when the
//      cel is overwritten or flushed.
//
//   3. Segment snapshot / restore / lazy-load — `snapshotSegment`,
//      `restoreSegment`, `flushSegmentToIdb`, `makeLazyLoadIdbSegment`.
//      Reuses the kernel's dehydrate / hydrate so segment JSON
//      round-trips identically.
//
// The package is browser-only. In Node / headless envs `installIdb`
// returns null without touching the registries, and any host code that
// declares `channel: "idb"` silently no-ops.
//
// No runtime dependencies. ~150 lines of glue talking to the raw IDB
// API; no `idb` npm package.
// ============================================================================

export {
  DEFAULT_DATABASE, DEFAULT_VERSION,
  STORE_CELS, STORE_BLOBS, STORE_SEGMENTS,
  hasIndexedDB, openIdb, requestPromise, transactionPromise, resolveStores,
} from "./db.js";
export type { IdbConfig, IdbStores, ResolvedStores } from "./db.js";

export { createIdbChannel } from "./channel.js";
export type { IdbChannelOptions } from "./channel.js";

export {
  IDB_BLOB_TAG, RESOLVE_BLOB_LAMBDA, STORE_BLOB_LAMBDA,
  idbBlobTag, makeResolveBlob, makeStoreBlob,
} from "./blob.js";
export type {
  IdbBlobHandle, ResolveBlobInputs, StoreBlobInputs,
} from "./blob.js";

export {
  LAZY_LOAD_LAMBDA,
  snapshotSegment, restoreSegment, flushSegmentToIdb,
  deleteSegmentSnapshot, listSnapshotKeys,
  makeLazyLoadIdbSegment,
} from "./snapshot.js";
export type { LazyLoadInputs, LazyLoadResult } from "./snapshot.js";

export {
  STATS_IDB_KEY, MEASURE_FOOTPRINT_LAMBDA,
  measureIdbFootprint, makeMeasureIdbFootprint,
} from "./stats.js";
export type {
  IdbFootprintSnapshot, MeasureFootprintInputs,
} from "./stats.js";

export {
  PLASTRON_IDB_SEGMENT, DEFAULT_IDB_CHANNEL_KEY,
  plastronIdbManifest, installIdb, getIdbInstallation,
} from "./install.js";
export type { InstallIdbOptions, IdbInstallation } from "./install.js";
