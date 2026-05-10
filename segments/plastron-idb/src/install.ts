// ============================================================================
// install — one-call setup for the plastron-idb segment.
//
// `installIdb(state, config?)`:
//
//   1. Returns null when `indexedDB` is missing (Node, headless).
//      No registry mutation happens in that path; cels declaring
//      `channel: "idb"` silently no-op (channel not in registry).
//
//   2. Otherwise, opens the configured database, registers:
//        • channel "idb"        → createIdbChannel(db)
//        • tag      "idb-blob"   → idbBlobTag(db)
//        • lambdas  resolveBlob, storeBlob, measureIdbFootprint
//        • segment manifest under PLASTRON_IDB_SEGMENT
//      Returns the live IDBDatabase.
//
//      Lazy-loading a segment is a recipe, not a registered lambda:
//      hosts call `makeLazyLoadIdbSegment(state, db, segmentKey)`
//      directly and either invoke the result themselves or register
//      it under a host-chosen lambda key. No `lazyLoadIdbSegment`
//      key is registered or advertised by this segment.
//
//   3. Idempotent — calling installIdb a second time on the same state
//      with the same database returns the cached connection without
//      re-registering. Different database / version raises an error;
//      use a fresh state for that.
// ============================================================================

import type {
  ChannelKey, Fn, LambdaKey, SegmentManifest, State, TagKey,
} from "../../../plastron/src/index.js";
import { STATS_SEGMENT } from "../../../plastron/src/index.js";
import {
  hasIndexedDB, openIdb, resolveStores,
  DEFAULT_DATABASE, DEFAULT_VERSION,
} from "./db.js";
import type { IdbConfig } from "./db.js";
import { createIdbChannel } from "./channel.js";
import {
  IDB_BLOB_TAG, RESOLVE_BLOB_LAMBDA, STORE_BLOB_LAMBDA,
  idbBlobTag, makeResolveBlob, makeStoreBlob,
} from "./blob.js";
import { MEASURE_FOOTPRINT_LAMBDA, makeMeasureIdbFootprint } from "./stats.js";

export const PLASTRON_IDB_SEGMENT = "plastron-idb" as const;
export const DEFAULT_IDB_CHANNEL_KEY: ChannelKey = "idb";

/** Manifest declaring what `installIdb` puts into the kernel
 *  registries. No `dependsOn` — the package works standalone. The
 *  channel default ("idb") is the value advertised here; if a host
 *  passes `options.channelKey`, the manifest's `provides.channels`
 *  is overwritten with that override (matching plastron-dom's
 *  multi-install pattern). */
export const plastronIdbManifest: SegmentManifest = {
  segment: PLASTRON_IDB_SEGMENT,
  version: "0.0.1",
  description:
    "IndexedDB persistence segment — per-cel debounced write-out via channel \"idb\", " +
    "opaque large-value support via tag \"idb-blob\", and snapshot/restore helpers " +
    "for whole segments.",
  provides: {
    channels: [DEFAULT_IDB_CHANNEL_KEY],
    tags: [IDB_BLOB_TAG],
    lambdas: [
      RESOLVE_BLOB_LAMBDA,
      STORE_BLOB_LAMBDA,
      MEASURE_FOOTPRINT_LAMBDA,
    ],
    // `stats` is listed alongside the package's own segment so the
    // shared-celSegments cleanup in core/flush.ts walks it on
    // flush("plastron-idb"); the only cel we put there is
    // `plastron-idb_stats`, which the prefix heuristic catches.
    celSegments: [PLASTRON_IDB_SEGMENT, STATS_SEGMENT],
  },
};

export interface InstallIdbOptions extends IdbConfig {
  /** Channel key to register under. Default "idb". Pass a different
   *  key when installing alongside another idb-flavored channel. */
  channelKey?: ChannelKey;
  /** Tag key to register the blob handler under. Default "idb-blob". */
  tagKey?: TagKey;
  /** Channel debounce window. Forwarded to createIdbChannel. */
  debounceMs?: number;
}

export interface IdbInstallation {
  /** The opened IDBDatabase. Hosts can re-use this for direct queries
   *  outside the channel. */
  db: IDBDatabase;
  /** The channel key this install registered under. */
  channelKey: ChannelKey;
  /** The tag key this install registered under. */
  tagKey: TagKey;
  /** Lambda keys registered. Useful for cross-checking against a
   *  segment's expected `dependsOn` shape. */
  lambdas: LambdaKey[];
}

// Per-state cache so installIdb is idempotent within one State.
const installations = new WeakMap<State, IdbInstallation>();

/** Install plastron-idb on an existing State. Returns the installation
 *  on success, or null when IndexedDB isn't available in this runtime
 *  (Node, headless test envs without a polyfill). The returned object
 *  has stable identity for the lifetime of the State — repeated calls
 *  with the same database return the same object. */
export const installIdb = async (
  state: State,
  options: InstallIdbOptions = {},
): Promise<IdbInstallation | null> => {
  if (!hasIndexedDB()) return null;

  const requestedDbName = options.database ?? DEFAULT_DATABASE;
  const requestedVersion = options.version ?? DEFAULT_VERSION;

  const cached = installations.get(state);
  if (cached) {
    if (
      cached.db.name === requestedDbName &&
      cached.db.version === requestedVersion
    ) {
      return cached;
    }
    throw new Error(
      `installIdb: state already bound to ${cached.db.name}@${cached.db.version}; ` +
      `requested ${requestedDbName}@${requestedVersion}. Use a fresh state.`,
    );
  }

  const channelKey = options.channelKey ?? DEFAULT_IDB_CHANNEL_KEY;
  const tagKey = options.tagKey ?? IDB_BLOB_TAG;

  if (state.channelRegistry.has(channelKey)) {
    throw new Error(
      `installIdb: channel "${channelKey}" already registered. ` +
      `Pass options.channelKey to namespace.`,
    );
  }
  if (state.tagRegistry.has(tagKey)) {
    throw new Error(
      `installIdb: tag "${tagKey}" already registered. ` +
      `Pass options.tagKey to namespace.`,
    );
  }

  const db = await openIdb({
    database: requestedDbName,
    version: requestedVersion,
    stores: options.stores,
  });

  const stores = resolveStores(options);

  // Channel
  const channelOpts: { debounceMs?: number; store: string } = { store: stores.cels };
  if (options.debounceMs !== undefined) channelOpts.debounceMs = options.debounceMs;
  state.channelRegistry.set(channelKey, createIdbChannel(db, channelOpts));

  // Tag
  state.tagRegistry.set(tagKey, idbBlobTag(db, stores.blobs));

  // Lambdas — registered directly into state.fns + state.fnMetadata.
  // We don't go through registerLambda because the calling contract
  // prefers raw fn registration here (no schema attachments, no
  // compiler involvement). Skip if a key is already present (e.g.
  // host pre-registered) to stay idempotent under partial setups.
  const lambdas: Array<[LambdaKey, Fn]> = [
    [RESOLVE_BLOB_LAMBDA, makeResolveBlob(db, stores.blobs) as Fn],
    [STORE_BLOB_LAMBDA, makeStoreBlob(db, stores.blobs) as Fn],
    [
      MEASURE_FOOTPRINT_LAMBDA,
      makeMeasureIdbFootprint(state, db, {
        blobs: stores.blobs,
        segments: stores.segments,
      }) as Fn,
    ],
  ];
  for (const [k, fn] of lambdas) {
    if (state.fns.has(k) && state.fnMetadata.get(k)?.locked) continue;
    state.fns.set(k, fn);
    state.fnMetadata.set(k, { key: k, kind: "native" });
  }

  // Manifest. Honour channelKey / tagKey overrides by patching the
  // advertised provides — matches plastron-dom's last-write-wins
  // multi-install convention.
  const isDefaults = channelKey === DEFAULT_IDB_CHANNEL_KEY && tagKey === IDB_BLOB_TAG;
  const manifest: SegmentManifest = isDefaults
    ? plastronIdbManifest
    : {
        ...plastronIdbManifest,
        provides: {
          ...plastronIdbManifest.provides,
          channels: [channelKey],
          tags: [tagKey],
        },
      };

  // Record the manifest by hydrating an empty segment — there are no
  // cels to install, so a synthetic segment with manifest is the
  // cleanest way to advertise this segment to listSegments / flush.
  // `hydrate` is locked in coreFns; absence here would mean the host
  // bypassed createInitialState, which is not a contract we honor.
  const hydrate = state.fns.get("hydrate") as Fn;
  hydrate(state, [{ key: PLASTRON_IDB_SEGMENT, cels: [], manifest }], []);

  const installation: IdbInstallation = {
    db,
    channelKey,
    tagKey,
    lambdas: lambdas.map(([k]) => k),
  };
  installations.set(state, installation);
  return installation;
};

/** Look up the cached installation for a state, if any. Returns null
 *  when installIdb hasn't run on this state (or returned null itself
 *  in a no-IDB env). */
export const getIdbInstallation = (state: State): IdbInstallation | null =>
  installations.get(state) ?? null;
