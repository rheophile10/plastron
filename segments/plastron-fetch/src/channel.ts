import type {
  ChannelEnqueue, ChannelHandler, State,
} from "../../../plastron/src/index.js";

// ========================================================================
// fetch channel — observation-only, optional debounce.
//
// The channel does NOT drive HTTP work. The async fetch lambdas already
// settle their results into `cel.v` via the cascade. This channel is
// here for two reasons:
//
//   1. Observation. Hosts wanting "settled response committed" hooks
//      (e.g. analytics, logging, devtools) bind cels to this channel
//      and pass `onCommit` to receive notifications.
//   2. Coalescing. With `debounceMs > 0`, repeated enqueues for the
//      same cel within the window collapse to one onCommit call —
//      useful for search-as-you-type style flows where the host wants
//      "fire once after the user stops typing." The cels themselves
//      still settle on the cascade's clock; the channel only delays
//      the observer hook.
//
// Pass-through default (debounceMs === 0) means: every enqueue calls
// onCommit synchronously inline. drain is a no-op (nothing queued).
// dispose is idempotent.
//
// We do NOT coalesce by URL — that's policy. A "coalesce by URL" or
// "deduplicate identical requests" channel is straightforward to
// build on top of this one (read cel.v.url, hash, …) but is not the
// kind of decision a generic baseline should make.
// ========================================================================

export const DEFAULT_FETCH_CHANNEL_KEY = "fetch" as const;

export interface FetchChannelOptions {
  /** Coalescing window in milliseconds. 0 = pass-through (sync onCommit
   *  per enqueue). > 0 = coalesce repeated enqueues for the same cel
   *  key within the window into a single onCommit at window end.
   *  Default 0. */
  debounceMs?: number;
  /** Fired when a cel value commits through the channel. Receives the
   *  cel key and its current value. Sync; throw is swallowed (the
   *  channel never crashes the kernel). Optional — without this, the
   *  channel is a no-op observer. */
  onCommit?: (celKey: string, value: unknown) => void;
}

interface QueuedEntry {
  celKey: string;
  value: unknown;
}

/** Build a fetch ChannelHandler. Hosts register the result manually:
 *
 *    state.channelRegistry.set("fetch", createFetchChannel(state, opts));
 *
 *  installFetch() does this for you with default options. */
export const createFetchChannel = (
  _state: State,
  opts: FetchChannelOptions = {},
): ChannelHandler => {
  const debounceMs = opts.debounceMs ?? 0;
  const onCommit = opts.onCommit;

  const queue = new Map<string, QueuedEntry>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const fireOne = (entry: QueuedEntry): void => {
    if (!onCommit) return;
    try { onCommit(entry.celKey, entry.value); }
    catch { /* swallow — never crash the cascade from a channel */ }
  };

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (queue.size === 0) return;
    const pending = [...queue.values()];
    queue.clear();
    for (const entry of pending) fireOne(entry);
  };

  const scheduleFlush = (): void => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, debounceMs);
  };

  const enqueue = ({ cel }: ChannelEnqueue): void => {
    if (disposed) return;
    const entry: QueuedEntry = { celKey: cel.key, value: cel.v };
    if (debounceMs <= 0) {
      // Pass-through. No queueing; fire onCommit synchronously.
      fireOne(entry);
      return;
    }
    queue.set(cel.key, entry); // last write wins per cel key in window
    scheduleFlush();
  };

  const hasPending = (): boolean => queue.size > 0 || timer !== null;

  const drain = (): void => {
    flush();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    queue.clear();
  };

  return { enqueue, hasPending, drain, dispose };
};
