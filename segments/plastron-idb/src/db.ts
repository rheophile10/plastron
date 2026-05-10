// ============================================================================
// db — IndexedDB connection management.
//
// Owns one IDBDatabase per (database name, version) pair. Three object
// stores are created on first open:
//
//   • cels      — keyed by cel key, value = { v, segment? }
//                 written by the persistence channel.
//   • blobs     — keyed by uuid, value = Blob | ArrayBuffer | …
//                 written by storeBlob, deleted by the idb-blob tag's
//                 release.
//   • segments  — keyed by segment name, value = full Segment JSON
//                 written by snapshotSegment.
//
// The package is browser-only. `hasIndexedDB()` returns false in Node /
// headless environments; `openIdb` rejects with a clear error there.
// `installIdb` (in install.ts) checks `hasIndexedDB()` first and
// returns null without ever calling `openIdb` in that environment.
// ============================================================================

export const DEFAULT_DATABASE = "plastron" as const;
export const DEFAULT_VERSION = 1 as const;
export const STORE_CELS = "cels" as const;
export const STORE_BLOBS = "blobs" as const;
export const STORE_SEGMENTS = "segments" as const;

export interface IdbStores {
  cels?: string;
  blobs?: string;
  segments?: string;
}

export interface IdbConfig {
  /** Database name. Default: "plastron". */
  database?: string;
  /** Schema version. Bump when changing object stores. Default: 1. */
  version?: number;
  /** Object store names this package uses. Created on first open. */
  stores?: IdbStores;
}

export interface ResolvedStores {
  cels: string;
  blobs: string;
  segments: string;
}

export const resolveStores = (config: IdbConfig): ResolvedStores => ({
  cels: config.stores?.cels ?? STORE_CELS,
  blobs: config.stores?.blobs ?? STORE_BLOBS,
  segments: config.stores?.segments ?? STORE_SEGMENTS,
});

/** True when the runtime exposes an `indexedDB` global. The check is
 *  intentionally narrow — Node, deno-no-shim, and headless test envs
 *  return false, while every modern browser returns true. Hosts that
 *  have polyfilled IDB (e.g. fake-indexeddb in a test) get true. */
export const hasIndexedDB = (): boolean => {
  return typeof (globalThis as { indexedDB?: unknown }).indexedDB !== "undefined";
};

/** Open the configured database, creating any missing object stores
 *  inside `onupgradeneeded`. Resolves with the live IDBDatabase.
 *
 *  Rejects with a descriptive error when `indexedDB` isn't on
 *  globalThis — callers should gate with `hasIndexedDB()` first.
 *  `installIdb` does this for you and returns null in non-browser
 *  envs without ever calling `openIdb`. */
export const openIdb = (config: IdbConfig = {}): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    if (!hasIndexedDB()) {
      reject(new Error(
        "openIdb: indexedDB is not available in this environment. " +
        "plastron-idb is browser-only; gate with hasIndexedDB() first.",
      ));
      return;
    }
    const dbName = config.database ?? DEFAULT_DATABASE;
    const version = config.version ?? DEFAULT_VERSION;
    const stores = resolveStores(config);

    const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
    const req = idb.open(dbName, version);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(stores.cels)) {
        db.createObjectStore(stores.cels);
      }
      if (!db.objectStoreNames.contains(stores.blobs)) {
        db.createObjectStore(stores.blobs);
      }
      if (!db.objectStoreNames.contains(stores.segments)) {
        db.createObjectStore(stores.segments);
      }
    };
  });
};

/** Promisify a single IDBRequest. */
export const requestPromise = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** Promisify transaction completion. */
export const transactionPromise = (tx: IDBTransaction): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("idb: transaction aborted"));
  });
