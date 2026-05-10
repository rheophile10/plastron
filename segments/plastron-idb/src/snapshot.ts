// ============================================================================
// snapshot — segment-level snapshot / restore / flush helpers.
//
// Reuse the existing `dehydrate` and `hydrate` core fns to round-trip
// JSON; persistence is just the storage of that JSON in IDB's
// "segments" store (one row per segment key).
//
// `flushSegmentToIdb` is the eviction primitive: snapshot, then drop
// the cels from memory via the kernel's `flush` core fn. Round-trip
// with `restoreSegment`.
//
// `lazySegment` and `lazyLoadIdbSegment` give hosts a recipe for
// hydrate-on-first-read — useful for very large reference catalogs.
// The package ships them as a documented pattern; hosts choose to wire
// it in.
// ============================================================================

import type {
  Fn, Key, LambdaKey, Segment, State,
} from "../../../plastron/src/index.js";
import { requestPromise, transactionPromise, STORE_SEGMENTS } from "./db.js";

export const LAZY_LOAD_LAMBDA = "lazyLoadIdbSegment" as const;

/** Write the named segment to IDB. The segment's manifest (when
 *  present) round-trips inside the JSON, as do schemas / fnMetaData /
 *  downstream closures attached at dehydrate time. The kernel's
 *  dehydrate already filters out the reserved "core" / "stats"
 *  segments, so calling this with one of those keys throws cleanly. */
export const snapshotSegment = async (
  state: State,
  segmentKey: Key,
  db: IDBDatabase,
  storeName: string = STORE_SEGMENTS,
): Promise<void> => {
  const dehydrate = state.fns.get("dehydrate") as Fn | undefined;
  if (!dehydrate) {
    throw new Error("snapshotSegment: state.fns has no \"dehydrate\" entry");
  }
  const segments = dehydrate(state) as Segment[];
  const target = segments.find((s) => s.key === segmentKey);
  if (!target) {
    throw new Error(
      `snapshotSegment: segment "${segmentKey}" not found in dehydrated output ` +
      `(reserved segments like "core" / "stats" are filtered).`,
    );
  }
  const tx = db.transaction([storeName], "readwrite");
  tx.objectStore(storeName).put(target, segmentKey);
  await transactionPromise(tx);
};

/** Read a previously snapshotted segment from IDB and hydrate it back
 *  into the live state. Optional `fns` argument matches `hydrate`'s
 *  signature — pass any fn maps the segment's lambdas reference. */
export const restoreSegment = async (
  state: State,
  segmentKey: Key,
  db: IDBDatabase,
  fns: Map<LambdaKey, Fn>[] = [],
  storeName: string = STORE_SEGMENTS,
): Promise<void> => {
  const tx = db.transaction([storeName], "readonly");
  const seg = await requestPromise<Segment | undefined>(
    tx.objectStore(storeName).get(segmentKey),
  );
  if (!seg) {
    throw new Error(`restoreSegment: segment "${segmentKey}" not in IDB`);
  }
  const hydrate = state.fns.get("hydrate") as Fn | undefined;
  if (!hydrate) {
    throw new Error("restoreSegment: state.fns has no \"hydrate\" entry");
  }
  hydrate(state, [seg], fns);
};

/** Snapshot the segment, then call the kernel's `flush` core fn to
 *  drop its cels. Round-trip with `restoreSegment` reproduces the
 *  graph. Cascades through dependent segments are NOT requested here —
 *  pass `{ cascade: true }` in your own follow-up `flush` call if you
 *  need that. */
export const flushSegmentToIdb = async (
  state: State,
  segmentKey: Key,
  db: IDBDatabase,
  storeName: string = STORE_SEGMENTS,
): Promise<void> => {
  await snapshotSegment(state, segmentKey, db, storeName);
  const flush = state.fns.get("flush") as Fn | undefined;
  if (!flush) {
    throw new Error("flushSegmentToIdb: state.fns has no \"flush\" entry");
  }
  await flush(state, segmentKey);
};

/** Delete a snapshotted segment from IDB. No-op when the row doesn't
 *  exist. Useful for "user reset their workspace" flows. */
export const deleteSegmentSnapshot = async (
  segmentKey: Key,
  db: IDBDatabase,
  storeName: string = STORE_SEGMENTS,
): Promise<void> => {
  const tx = db.transaction([storeName], "readwrite");
  tx.objectStore(storeName).delete(segmentKey);
  await transactionPromise(tx);
};

/** List every segment key currently snapshotted in IDB. Useful for
 *  "what segments can I lazy-load?" UIs. */
export const listSnapshotKeys = async (
  db: IDBDatabase,
  storeName: string = STORE_SEGMENTS,
): Promise<Key[]> => {
  const tx = db.transaction([storeName], "readonly");
  const keys = await requestPromise<IDBValidKey[]>(
    tx.objectStore(storeName).getAllKeys(),
  );
  return keys.map((k) => String(k));
};

// ── Lazy-load lambda ───────────────────────────────────────────────────────
//
// Returned closure shape — kept here as a reference so hosts can wire
// it onto a control cel:
//
//   const cel = {
//     key: "lazy_archive",
//     segment: "config",
//     v: { loaded: false, loading: false },
//     l: "lazyLoadIdbSegment",
//     inputMap: { trigger: "some_trigger_cel" },
//   };
//
// The lambda body sees `inputs.trigger` (whatever the host wires in)
// plus closure-bound `db` / `segmentKey`. First fire kicks off
// `restoreSegment` and immediately returns `{ loaded: false, loading: true }`.
// While the load is in flight, repeated fires return the same in-flight
// payload. After completion, the host should mutate the cel via
// `setCel(cel.key, { v: { loaded: true, loading: false } })` or otherwise
// signal the rest of the graph that the segment is ready.

export interface LazyLoadInputs {
  /** Anything — the lambda only inspects whether it has fired before. */
  [k: string]: unknown;
}

export interface LazyLoadResult {
  loaded: boolean;
  loading: boolean;
  error?: string;
}

/** Build a lambda that hydrates `segmentKey` on first fire. The lambda
 *  is async — wave-level Promise.all handles it alongside other I/O.
 *
 *  Note: the lambda CANNOT mutate its own cel.v inside the cascade
 *  (that's the closed-loop write the kernel forbids for lambda cels).
 *  Hosts use this in one of two patterns:
 *
 *    A. Fire-and-forget on a control cel (cel.l = lazyLoadIdbSegment).
 *       The cel returns the current { loaded, loading } status.
 *       Restoration kicks off in the background; on completion, the
 *       host calls `set(state, "lazy_status", "ready")` to fan out.
 *
 *    B. Direct call from host code: `await loader({ ... })` and then
 *       run a `runCycle` to propagate the now-hydrated cels.
 *
 *  The included implementation supports pattern A with internal state
 *  shared across fires. */
export const makeLazyLoadIdbSegment = (
  state: State,
  db: IDBDatabase,
  segmentKey: Key,
  fns: Map<LambdaKey, Fn>[] = [],
  storeName: string = STORE_SEGMENTS,
): ((inputs: LazyLoadInputs) => Promise<LazyLoadResult>) => {
  let loaded = false;
  let loading = false;
  let lastError: string | undefined;

  return async (_inputs: LazyLoadInputs): Promise<LazyLoadResult> => {
    if (loaded) return { loaded: true, loading: false };
    if (loading) return { loaded: false, loading: true };
    loading = true;
    try {
      await restoreSegment(state, segmentKey, db, fns, storeName);
      loaded = true;
      loading = false;
      return { loaded: true, loading: false };
    } catch (e) {
      loading = false;
      lastError = e instanceof Error ? e.message : String(e);
      return { loaded: false, loading: false, error: lastError };
    }
  };
};
