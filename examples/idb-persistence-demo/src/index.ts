// ============================================================================
// idb-persistence-demo — exercises plastron-idb end-to-end IN A BROWSER.
//
// This file is browser-only — it talks to `globalThis.indexedDB`.
// Type-checking with `tsc --noEmit` validates the API surface; runtime
// verification needs a real IDB implementation, so load this in a
// browser bundle (Vite / esbuild / similar) or test it via
// fake-indexeddb in jsdom.
//
// Demo steps (mirrors task-indexeddb-interop.md acceptance criteria):
//
//   1. Boot a state, install plastron-idb. Skip in non-browser envs.
//   2. Create a "notes" segment with N text cels, all bound to the
//      "idb" channel. Mutate them; the channel debounces to a single
//      transaction.
//   3. Tear down the in-memory state, build a fresh one, restore the
//      "notes" segment from IDB. Cels are reconstituted with the
//      previously-written values.
//   4. Demonstrate the blob handle: store a small blob via `storeBlob`,
//      hold the handle in a cel, fetch the bytes back via
//      `resolveBlob`. Overwrite the cel — the IDB row is gone.
//   5. snapshotSegment + flush + restoreSegment round-trip. Inspect
//      that the post-restore cel.v matches pre-flush.
//   6. measureIdbFootprint reports byte totals for the "blobs" /
//      "segments" stores.
//
// Console output uses `console.log`. Open devtools to follow along.
// ============================================================================

import type { Fn, Segment, State } from "../../../plastron/src/index.js";
import {
  createInitialState, STATS_SEGMENT,
} from "../../../plastron/src/index.js";
import {
  hasIndexedDB, installIdb,
  snapshotSegment, restoreSegment, flushSegmentToIdb,
  measureIdbFootprint, listSnapshotKeys,
  STATS_IDB_KEY,
  type IdbBlobHandle, type IdbInstallation, type IdbFootprintSnapshot,
} from "../../../segments/plastron-idb/src/index.js";

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.log(...args);
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ── Setup ──────────────────────────────────────────────────────────────────

if (!hasIndexedDB()) {
  log("[idb-persistence-demo] indexedDB not available — exiting cleanly.");
  log("This demo runs in a browser. In Node, installIdb returns null and");
  log("cels with channel: \"idb\" silently no-op (no errors).");
} else {
  await main();
}

async function main(): Promise<void> {
  const state = createInitialState();
  const installation = await installIdb(state, {
    database: "plastron-demo",
    version: 1,
    debounceMs: 50, // shorter debounce for snappy demo feedback
  });
  if (!installation) {
    log("[idb-persistence-demo] installIdb returned null. Exiting.");
    return;
  }
  log("[idb-persistence-demo] installed:", {
    db: installation.db.name,
    channel: installation.channelKey,
    tag: installation.tagKey,
    lambdas: installation.lambdas,
  });

  await stepNotesSegment(state, installation);
  await stepBlobHandle(state, installation);
  await stepSnapshotRoundTrip(state, installation);
  await stepFootprint(state, installation);

  log("\n[idb-persistence-demo] done.");
}

// ── 1. Notes segment with channel: "idb" ───────────────────────────────────

async function stepNotesSegment(
  state: State,
  installation: IdbInstallation,
): Promise<void> {
  log("\n=== 1. notes segment with channel: \"idb\" ===");
  const hydrate = state.fns.get("hydrate") as Fn;
  const set = state.fns.get("set") as Fn;

  const notesSegment: Segment = {
    key: "notes",
    cels: [
      { key: "note_0", v: "draft", segment: "notes", channel: installation.channelKey },
      { key: "note_1", v: "draft", segment: "notes", channel: installation.channelKey },
      { key: "note_2", v: "draft", segment: "notes", channel: installation.channelKey },
    ],
  };
  hydrate(state, [notesSegment], []);

  // Burst of writes — the channel coalesces all of these into one
  // transaction within the debounce window.
  for (let i = 0; i < 100; i++) {
    await set(state, "note_0", `revision ${i}`);
  }
  await set(state, "note_1", "saved");
  await set(state, "note_2", "saved");

  // Drain to flush pending writes synchronously for the demo. In a
  // real app the rAF / debounce / next-cycle naturally drains.
  const drain = state.fns.get("drain") as Fn;
  await drain(state, "all");
  await sleep(60); // give the timer-driven path a chance too

  // Read directly from IDB to confirm.
  const tx = installation.db.transaction(["cels"], "readonly");
  const stored = await new Promise<unknown>((resolve, reject) => {
    const req = tx.objectStore("cels").get("note_0");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  log("note_0 in IDB:", stored, "(expected v: \"revision 99\" after coalescing)");
}

// ── 2. Blob handle tag ─────────────────────────────────────────────────────

async function stepBlobHandle(
  state: State,
  installation: IdbInstallation,
): Promise<void> {
  log("\n=== 2. idb-blob tag — store, hold, resolve, release ===");
  const hydrate = state.fns.get("hydrate") as Fn;
  const set = state.fns.get("set") as Fn;
  const get = state.fns.get("get") as Fn;

  // Synthesize a small blob.
  const data = new Blob(["hello plastron"], { type: "text/plain" });

  const storeBlob = state.fns.get("storeBlob") as Fn;
  const handle1 = await storeBlob({ data, mime: "text/plain" }) as IdbBlobHandle;
  log("storeBlob ->", handle1);

  // Hold the handle in a cel with tag: "idb-blob".
  hydrate(state, [{
    key: "blobs",
    cels: [
      {
        key: "current_blob",
        v: handle1,
        segment: "blobs",
        tag: installation.tagKey,
      },
    ],
  }], []);

  // Resolve the bytes back via the resolveBlob lambda.
  const resolveBlob = state.fns.get("resolveBlob") as Fn;
  const fetched = await resolveBlob({ handle: handle1 }) as Blob;
  if (fetched instanceof Blob) {
    const text = await fetched.text();
    log("resolveBlob ->", text);
  }

  // Overwrite the cel: the kernel calls the tag's release on the old
  // handle, deleting the IDB row.
  const handle2 = await storeBlob({
    data: new Blob(["second blob"], { type: "text/plain" }),
    mime: "text/plain",
  }) as IdbBlobHandle;
  await set(state, "current_blob", handle2);

  log("after overwrite, current_blob.v =", get(state, "current_blob"));

  // Confirm the old row is gone.
  const tx = installation.db.transaction(["blobs"], "readonly");
  const oldGone = await new Promise<unknown>((resolve, reject) => {
    const req = tx.objectStore("blobs").get(handle1.idbKey);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  log("old handle1 in IDB:", oldGone, "(expected undefined)");
}

// ── 3. snapshot / flush / restore round-trip ───────────────────────────────

async function stepSnapshotRoundTrip(
  state: State,
  installation: IdbInstallation,
): Promise<void> {
  log("\n=== 3. snapshot / flushSegmentToIdb / restoreSegment ===");
  const get = state.fns.get("get") as Fn;

  const beforeNotes = ["note_0", "note_1", "note_2"].map((k) => [k, get(state, k)]);
  log("before flush:", beforeNotes);

  await snapshotSegment(state, "notes", installation.db);
  log("snapshotSegment(\"notes\") OK");

  log("snapshots in IDB:", await listSnapshotKeys(installation.db));

  // flushSegmentToIdb evicts the cels.
  await flushSegmentToIdb(state, "notes", installation.db);
  const evicted = ["note_0", "note_1", "note_2"].map((k) => [k, get(state, k)]);
  log("after flush:", evicted, "(expected undefined)");

  // Restore — cels come back with the snapshot's values.
  await restoreSegment(state, "notes", installation.db);
  const restored = ["note_0", "note_1", "note_2"].map((k) => [k, get(state, k)]);
  log("after restore:", restored, "(expected to match before-flush)");
}

// ── 4. measureIdbFootprint ─────────────────────────────────────────────────

async function stepFootprint(
  state: State,
  installation: IdbInstallation,
): Promise<void> {
  log("\n=== 4. measureIdbFootprint -> stats_idb ===");
  const snap: IdbFootprintSnapshot = await measureIdbFootprint(state, installation.db);
  log("snapshot:", snap);

  // The stats_idb cel was populated as a side effect.
  const cel = state.cels.get(STATS_IDB_KEY);
  log("stats_idb segment:", cel?.segment, "(expected:", STATS_SEGMENT, ")");
  log("stats_idb.v.totalBytes:", (cel?.v as IdbFootprintSnapshot)?.totalBytes);
}
