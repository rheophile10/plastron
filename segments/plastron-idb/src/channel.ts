// ============================================================================
// channel — IDB persistence channel.
//
// Per-cel write-out to an IndexedDB object store. Bound cels declare
//
//   cel.channel = "idb"   (or include "idb" in the array)
//
// On every value change runCascade calls `enqueue({cel, state})`. We
// capture the value at enqueue time — by drain time the cel may have
// changed again, but we want the value as of THIS change for monotonic
// history. Coalescing within the debounce window is "last write wins"
// per cel key.
//
// Drain is async. The kernel awaits it inside flushChannels (fixed-
// point loop). Sync-wrapped channels in plastron-perf still see a
// Promise return — this drain returns Promise<void> from the start.
//
// Debounce default: 100 ms. Rationale:
//   • Long enough to coalesce a typical "user types into a field"
//     burst into one transaction.
//   • Short enough that a single keystroke is durable within
//     ~200 ms window even under load.
//   • Matches the default the spec recommends.
// ============================================================================

import type {
  ChannelHandler, ChannelEnqueue, Key,
} from "../../../plastron/src/index.js";
import { transactionPromise, STORE_CELS } from "./db.js";

export interface IdbChannelOptions {
  /** Debounce window in ms. Default 100. */
  debounceMs?: number;
  /** Object store for cel writes. Default "cels". */
  store?: string;
}

interface QueueEntry {
  v: unknown;
  segment?: Key;
}

/** Build an IDB-backed ChannelHandler. The handler owns its queue, its
 *  debounce timer, and a single store reference. Multiple cels writing
 *  to the same key within one debounce window collapse into one put. */
export const createIdbChannel = (
  db: IDBDatabase,
  opts: IdbChannelOptions = {},
): ChannelHandler => {
  const debounceMs = opts.debounceMs ?? 100;
  const storeName = opts.store ?? STORE_CELS;
  const queue = new Map<Key, QueueEntry>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  // True while a drainNow() Promise is outstanding. drain() awaits the
  // existing one rather than firing a parallel transaction over the
  // same cel keys (IDB serializes anyway, but this keeps hasPending
  // honest and avoids a confusing "drain returned but writes still in
  // flight" gap).
  let inFlight: Promise<void> | null = null;

  const drainNow = async (): Promise<void> => {
    if (queue.size === 0) return;
    const entries = Array.from(queue);
    queue.clear();
    const tx = db.transaction([storeName], "readwrite");
    const store = tx.objectStore(storeName);
    for (const [key, payload] of entries) {
      try {
        store.put(payload, key);
      } catch (e) {
        // Structured-clone failure (functions, DOM nodes, certain
        // class instances). Log and skip — silently dropping would
        // surprise hosts; throwing would abort the whole transaction.
        const c = (globalThis as { console?: { warn?: (...a: unknown[]) => void } }).console;
        c?.warn?.(`idb-channel: unstoreable cel "${key}" — skipping`, e);
      }
    }
    await transactionPromise(tx);
  };

  const handler: ChannelHandler = {
    enqueue: ({ cel }: ChannelEnqueue): void => {
      const entry: QueueEntry = { v: cel.v };
      if (cel.segment !== undefined) entry.segment = cel.segment;
      queue.set(cel.key, entry);
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          // Best-effort: catch errors so the timer callback never
          // throws into the host's task queue. The kernel's drain()
          // path bubbles errors through its own Promise return.
          inFlight = drainNow().finally(() => { inFlight = null; });
          inFlight.catch((e) => {
            const c = (globalThis as { console?: { warn?: (...a: unknown[]) => void } }).console;
            c?.warn?.("idb-channel: timer-driven drain failed", e);
          });
        }, debounceMs);
      }
    },
    hasPending: (): boolean =>
      queue.size > 0 || timer !== null || inFlight !== null,
    drain: async (): Promise<void> => {
      if (timer) { clearTimeout(timer); timer = null; }
      // If a previous drain is still in flight, await it first so the
      // caller observes a fully settled queue before we start the next
      // transaction.
      if (inFlight) await inFlight;
      inFlight = drainNow().finally(() => { inFlight = null; });
      await inFlight;
    },
    dispose: (): void => {
      if (timer) { clearTimeout(timer); timer = null; }
      queue.clear();
      inFlight = null;
    },
  };

  return handler;
};
