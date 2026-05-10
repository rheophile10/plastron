// ============================================================================
// blob — opaque large-value handle tag and resolve/store lambdas.
//
// `IdbBlobHandle` is a JSON-shaped reference: the actual blob lives in
// the IDB "blobs" store at handle.idbKey. Cels holding a handle declare
// `tag: "idb-blob"`; the kernel's release path then deletes the IDB
// row when the cel is overwritten or flushed.
//
// `serialize` is identity — handles are already JSON-shaped and round-
// trip cleanly through dehydrate. The blob content lives in IDB and is
// emitted only via measureIdbFootprint or an explicit export pipeline.
//
// `byteLength` returns the handle's JS-heap cost (~64 bytes). The
// actual blob bytes live in IDB and are reported separately via
// measureIdbFootprint, written to stats_idb. Conflating the two would
// double-count or misattribute storage.
// ============================================================================

import type { TagHandler } from "../../../plastron/src/index.js";
import { requestPromise, transactionPromise, STORE_BLOBS } from "./db.js";

export const IDB_BLOB_TAG = "idb-blob" as const;
export const RESOLVE_BLOB_LAMBDA = "resolveBlob" as const;
export const STORE_BLOB_LAMBDA = "storeBlob" as const;

/** A reference to a blob persisted in IndexedDB. The handle is what
 *  lives in `cel.v`; the actual bytes are fetched via `resolveBlob`. */
export interface IdbBlobHandle {
  /** Key under the "blobs" store. Typically a uuid; opaque to the kernel. */
  idbKey: string;
  /** Byte size of the underlying blob. Reported as IDB-side bytes,
   *  not JS-heap bytes. */
  size: number;
  /** Optional MIME type — useful for UI render decisions. */
  mime?: string;
  /** Optional content hash for de-dup / integrity. */
  sha256?: string;
}

/** Rough estimate of a handle's footprint on the JS heap: 6-ish strings
 *  + a small object header. Tag estimator wins over schema estimator
 *  in `sizeOfCel` (see plastron/src/core/perf.ts). */
const HANDLE_HEAP_BYTES = 64;

/** Build a TagHandler for "idb-blob". Closes over `db` so release can
 *  fire-and-forget the delete without the caller passing a connection.
 *  Errors in release are swallowed by the kernel's release contract. */
export const idbBlobTag = (
  db: IDBDatabase,
  storeName: string = STORE_BLOBS,
): TagHandler => ({
  // Handle is JSON-shaped — round-trips identically. Returning a fresh
  // object would also work; identity keeps allocations down.
  serialize: (v: unknown): unknown => v,
  release: (v: unknown): void => {
    const h = v as IdbBlobHandle | null | undefined;
    if (!h || typeof h !== "object" || typeof h.idbKey !== "string") return;
    // Fire-and-forget. We can't await here — release is sync. Errors
    // are surfaced via the channel's own warn path; the kernel's
    // release wrapper swallows throws either way.
    try {
      const tx = db.transaction([storeName], "readwrite");
      tx.objectStore(storeName).delete(h.idbKey);
      // Don't await; nothing else to do. The transaction will commit
      // on its own when the microtask returns to the IDB queue.
    } catch (e) {
      const c = (globalThis as { console?: { warn?: (...a: unknown[]) => void } }).console;
      c?.warn?.(`idb-blob: release failed for ${h.idbKey}`, e);
    }
  },
  byteLength: () => HANDLE_HEAP_BYTES,
});

// ── Lambdas ─────────────────────────────────────────────────────────────────
//
// resolveBlob and storeBlob are async lambdas. plastron's wave-level
// Promise.all parallelizes them with other async work in the same wave.
// Hosts wire them onto cels via cel.l = "resolveBlob" / "storeBlob"
// (or call them directly outside the cascade).

export interface ResolveBlobInputs {
  handle: IdbBlobHandle | null | undefined;
}

/** Read the underlying blob from IDB. Returns the value as-stored —
 *  typically a Blob (browser File pipelines) or an ArrayBuffer. Returns
 *  null when the handle is missing or the row has been evicted. */
export const makeResolveBlob = (
  db: IDBDatabase,
  storeName: string = STORE_BLOBS,
) => async (inputs: ResolveBlobInputs): Promise<Blob | ArrayBuffer | null> => {
  const h = inputs.handle;
  if (!h || typeof h.idbKey !== "string") return null;
  const tx = db.transaction([storeName], "readonly");
  const result = await requestPromise<unknown>(tx.objectStore(storeName).get(h.idbKey));
  if (result == null) return null;
  return result as Blob | ArrayBuffer;
};

export interface StoreBlobInputs {
  /** The data to persist. Anything structured-cloneable that IDB
   *  accepts — Blob, File, ArrayBuffer, Uint8Array, … */
  data: Blob | ArrayBuffer | ArrayBufferView | null | undefined;
  /** Optional MIME type to record on the handle. */
  mime?: string;
  /** Optional explicit key. When omitted, a uuid is generated. Pass an
   *  explicit key for upsert semantics (overwrite an existing blob). */
  idbKey?: string;
}

/** Write a blob to IDB and return a fresh handle. Useful for ingest
 *  pipelines: "user dropped a file → stash it → return the handle as
 *  a cel value". The handle's `size` is the byte length of `data`. */
export const makeStoreBlob = (
  db: IDBDatabase,
  storeName: string = STORE_BLOBS,
) => async (inputs: StoreBlobInputs): Promise<IdbBlobHandle | null> => {
  const data = inputs.data;
  if (data == null) return null;
  const idbKey = inputs.idbKey ?? generateUuid();
  const size = byteSize(data);
  const tx = db.transaction([storeName], "readwrite");
  tx.objectStore(storeName).put(data, idbKey);
  await transactionPromise(tx);
  const handle: IdbBlobHandle = { idbKey, size };
  if (inputs.mime !== undefined) handle.mime = inputs.mime;
  return handle;
};

// RFC4122-v4 via the platform's crypto.randomUUID. This package is
// gated by hasIndexedDB(), and every browser shipping IndexedDB in the
// last several years also ships crypto.randomUUID — no fallback is
// needed. Hosts that want stronger guarantees (or non-uuid keys) can
// pass `idbKey` explicitly to storeBlob.
const generateUuid = (): string => globalThis.crypto.randomUUID();

const byteSize = (data: Blob | ArrayBuffer | ArrayBufferView): number => {
  if (data instanceof ArrayBuffer) return data.byteLength;
  // Blob has .size; ArrayBufferView has .byteLength. The TS type union
  // covers both.
  if ("size" in data) return (data as Blob).size;
  return (data as ArrayBufferView).byteLength;
};
