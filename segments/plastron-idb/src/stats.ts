// ============================================================================
// stats — IDB-side memory accounting.
//
// `measureIdbFootprint` walks the "blobs" and "segments" stores,
// summing byte sizes, and writes the result into a `stats_idb` cel
// under the reserved "stats" segment (matches task-perf-tracking.md
// convention). Direct `cel.v` mutation — same pattern the kernel's own
// flushCycleStats uses to avoid re-entering the cycle.
//
// This complements the tag handler's `byteLength`. The tag reports the
// JS-heap cost of the handle (~64 bytes); `measureIdbFootprint`
// reports the actual storage cost. The perf accountant adds the two
// when computing "total memory pressure for this dataset".
//
// IDB iteration is async and not cheap — call once on demand or via a
// scheduled cycle, not on every cascade.
// ============================================================================

import type { Cel, State } from "../../../plastron/src/index.js";
import { STATS_SEGMENT } from "../../../plastron/src/index.js";
import { requestPromise, STORE_BLOBS, STORE_SEGMENTS } from "./db.js";

// Cel key for the IDB footprint snapshot. Lives in the `stats`
// segment, but the key is namespaced under `plastron-idb_` so the
// shared-celSegments cleanup heuristic in core/flush.ts removes it
// when the host flushes "plastron-idb" (the heuristic matches
// `${owningSegmentKey}_` or `${owningSegmentKey}:` prefixes).
export const STATS_IDB_KEY = "plastron-idb_stats" as const;

export interface IdbFootprintSnapshot {
  /** Total byte size of every entry in the "blobs" store. Counts the
   *  stored payload (Blob.size, ArrayBuffer.byteLength). */
  blobsBytes: number;
  /** Number of rows in the "blobs" store. */
  blobsCount: number;
  /** Total byte size of every entry in the "segments" store. Counts
   *  the JSON length (UTF-8) of the stored Segment object. */
  segmentsBytes: number;
  /** Number of rows in the "segments" store. */
  segmentsCount: number;
  /** Sum of `blobsBytes + segmentsBytes`. */
  totalBytes: number;
  /** Database name + version, for cross-host comparability. */
  database: string;
  version: number;
  /** Wall-clock ms when measurement completed (Date.now()). */
  measuredAt: number;
}

/** Ensure the stats_idb cel exists. The cel is dynamic so downstream
 *  observers re-fire on the next cycle after a measurement update. */
const ensureStatsCel = (state: State): Cel => {
  let cel = state.cels.get(STATS_IDB_KEY);
  if (!cel) {
    cel = {
      key: STATS_IDB_KEY,
      v: null,
      segment: STATS_SEGMENT,
      dynamic: true,
    };
    state.cels.set(STATS_IDB_KEY, cel);
  }
  return cel;
};

/** Walk the "blobs" and "segments" stores, sum byte sizes, write the
 *  result into stats_idb.v. Returns the snapshot so callers that don't
 *  use stats cels can still consume the numbers directly. */
export const measureIdbFootprint = async (
  state: State,
  db: IDBDatabase,
  storeNames: { blobs?: string; segments?: string } = {},
): Promise<IdbFootprintSnapshot> => {
  const blobsStore = storeNames.blobs ?? STORE_BLOBS;
  const segmentsStore = storeNames.segments ?? STORE_SEGMENTS;

  const tx = db.transaction([blobsStore, segmentsStore], "readonly");
  const blobs = await requestPromise<unknown[]>(
    tx.objectStore(blobsStore).getAll(),
  );
  const segments = await requestPromise<unknown[]>(
    tx.objectStore(segmentsStore).getAll(),
  );

  let blobsBytes = 0;
  for (const v of blobs) {
    blobsBytes += sizeOfStoredBlob(v);
  }
  let segmentsBytes = 0;
  for (const v of segments) {
    segmentsBytes += sizeOfStoredSegment(v);
  }

  const snap: IdbFootprintSnapshot = {
    blobsBytes,
    blobsCount: blobs.length,
    segmentsBytes,
    segmentsCount: segments.length,
    totalBytes: blobsBytes + segmentsBytes,
    database: db.name,
    version: db.version,
    measuredAt: Date.now(),
  };

  // Direct mutation, mirroring the kernel's own stats writes. The cel
  // is dynamic so observers fan out on the next cycle.
  ensureStatsCel(state).v = snap;
  return snap;
};

const sizeOfStoredBlob = (v: unknown): number => {
  if (v == null) return 0;
  if (typeof ArrayBuffer !== "undefined" && v instanceof ArrayBuffer) {
    return v.byteLength;
  }
  if (typeof Blob !== "undefined" && v instanceof Blob) {
    return v.size;
  }
  if (ArrayBuffer.isView(v)) {
    return (v as ArrayBufferView).byteLength;
  }
  // Fall through for arbitrary structured-cloned objects: fall back to
  // a JSON length as a rough proxy. Best-effort; documented limitation.
  try {
    return jsonByteLength(v);
  } catch {
    return 0;
  }
};

const sizeOfStoredSegment = (v: unknown): number => {
  if (v == null) return 0;
  try {
    return jsonByteLength(v);
  } catch {
    return 0;
  }
};

const jsonByteLength = (v: unknown): number => {
  const json = JSON.stringify(v);
  if (json === undefined) return 0;
  // Approximate UTF-8 byte length without allocating a TextEncoder
  // when avoidable. ASCII-fast path falls through to TextEncoder for
  // multibyte content.
  let bytes = 0;
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate — paired with low surrogate to form a single
      // 4-byte UTF-8 code point.
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
};

/** Stats lambda key, registered by installIdb so the segment manifest
 *  can advertise it. Hosts wanting a cel-driven measurement (vs. an
 *  out-of-band call) can wire `cel.l = "measureIdbFootprint"`. */
export const MEASURE_FOOTPRINT_LAMBDA = "measureIdbFootprint" as const;

export interface MeasureFootprintInputs {
  /** Optional pulse cel — when its v changes, re-measure. */
  trigger?: unknown;
}

/** Build the cel-callable form of measureIdbFootprint. Returns the
 *  same snapshot so the cel value carries it (the stats_idb cel is
 *  also updated via the side-effect mutation inside the helper). */
export const makeMeasureIdbFootprint = (
  state: State,
  db: IDBDatabase,
  storeNames: { blobs?: string; segments?: string } = {},
) => async (_inputs: MeasureFootprintInputs): Promise<IdbFootprintSnapshot> => {
  return measureIdbFootprint(state, db, storeNames);
};
