import type { ChannelHandler, ChannelKey, Fn, Key, State } from "../types/index.js";
import { PRECOMPUTED_STATES_KEY, type PrecomputedIndexes } from "./precompute.js";
import { releaseValue } from "./hydrate.js";
import { affectedFor, runCascade } from "./runCycle.js";

// ----------------------------------------------------------------------------
// Channel flush — drain pending channel work to completion.
//
//   spec === undefined | 'none'    no flush
//   spec === 'all'                 fixed-point drain over every channel
//   spec is a ChannelKey           drain that one channel
//
// Fixed-point drain handles channel commits that re-enter the graph via
// set/batch: a commit may trigger a new cascade that enqueues to other
// channels. We loop until no channel has pending work. Capped at
// FLUSH_MAX_ITERATIONS to surface runaway feedback as an error rather
// than hang.
//
// Within an iteration, all pending channels run concurrently — sync
// drains complete inline, async drains (IndexedDB, fetch, file write)
// run in parallel via Promise.all. Iterations stay sequential so a
// commit's writeback gets observed by the next pass rather than
// racing with the channel that triggered it.
//
// flushChannels is async-by-construction. Callers that don't pass an
// opts.flush avoid the microtask entirely by not awaiting it (see
// set/batch below). Callers that do pass flush pay one microtask hop
// even when every channel is sync — acceptable, since flushing is
// already a "settle now, then continue" semantic.
// ----------------------------------------------------------------------------

export type FlushSpec = ChannelKey | "all" | "none";

const FLUSH_MAX_ITERATIONS = 64;

const collectPending = (state: State): ChannelHandler[] => {
  const pending: ChannelHandler[] = [];
  for (const ch of state.channelRegistry.values()) {
    if (ch.hasPending()) pending.push(ch);
  }
  return pending;
};

export const flushChannels = async (
  state: State, spec: FlushSpec | undefined,
): Promise<void> => {
  if (!spec || spec === "none") return;

  if (spec === "all") {
    let iterations = 0;
    while (true) {
      if (++iterations > FLUSH_MAX_ITERATIONS) {
        throw new Error(
          `flushChannels: exceeded ${FLUSH_MAX_ITERATIONS} iterations — ` +
          `channels may be in a feedback loop (commit triggers cascade ` +
          `that re-enqueues the same channel).`,
        );
      }
      const pending = collectPending(state);
      if (pending.length === 0) return;
      // Run drains in parallel. Sync drains return undefined and complete
      // inline; async drains run concurrently via Promise.all.
      const promises: Promise<void>[] = [];
      for (const ch of pending) {
        const r = ch.drain();
        if (r instanceof Promise) promises.push(r);
      }
      if (promises.length > 0) await Promise.all(promises);
    }
  }

  const ch = state.channelRegistry.get(spec);
  if (!ch || !ch.hasPending()) return;
  const r = ch.drain();
  if (r instanceof Promise) await r;
};

// ============================================================================
// Standard input fns — read and write the cel map, then fire only the
// affected subset of the cascade with change suppression so a write
// only re-runs the work that actually depends on what changed.
//
//   • set(key, value)    — fire downstream(key) ∪ dynamicCascade,
//                          seeded with [key] in `changed`
//   • batch(writes)      — fire ⋃downstream(writtenKeys) ∪ dynamicCascade,
//                          seeded with writtenKeys in `changed`
//   • touch / consume    — fire dynamicCascade with empty `changed`
//                          (only cels with `dynamic: true` actually fire)
//
// Direct writes are treated as authoritative — no diff check at write
// time. Lambdas use cel._isChanged for output-side suppression.
//
// Writes to a missing cel, a locked cel, or a lambda cel throw. Reads
// of missing keys return undefined.
// ============================================================================

const writeOne = (state: State, key: Key, value: unknown): void => {
  const cel = state.cels.get(key);
  if (!cel)        throw new Error(`set: unknown cel "${key}"`);
  if (cel.locked)  throw new Error(`set: cel "${key}" is locked`);
  if (cel.l)       throw new Error(`set: cel "${key}" is a lambda — cannot write directly`);
  releaseValue(cel.v, cel.tag, state.tagRegistry);
  cel.v = value;
};

const fireDynamic = async (state: State): Promise<void> => {
  const indexes = state.cels.get(PRECOMPUTED_STATES_KEY)?.v as PrecomputedIndexes | undefined;
  if (indexes) await runCascade(state, indexes.dynamicCascade, new Set());
};

export const get: Fn = (state: State, key: Key) => {
  return state.cels.get(key)?.v;
};

export interface SetOpts {
  /** When set, drain channels synchronously after the cascade returns.
   *  'all' walks every channel to fixed point (handles channel commits
   *  that re-enter the graph). A specific ChannelKey flushes just that
   *  channel. Omit (or 'none') to leave commits on their own clocks. */
  flush?: FlushSpec;
}

export const set: Fn = async (
  state: State, key: Key, value: unknown, opts?: SetOpts,
) => {
  writeOne(state, key, value);
  await runCascade(state, affectedFor(state, [key]), new Set([key]));
  if (opts?.flush) await flushChannels(state, opts.flush);
  return state;
};

export const batch: Fn = async (
  state: State, writes: Array<[Key, unknown]>, opts?: SetOpts,
) => {
  const writtenKeys = writes.map(([k]) => k);
  for (const [k, v] of writes) writeOne(state, k, v);
  await runCascade(state, affectedFor(state, writtenKeys), new Set(writtenKeys));
  if (opts?.flush) await flushChannels(state, opts.flush);
  return state;
};

export const touch: Fn = async (state: State, opts?: SetOpts) => {
  await fireDynamic(state);
  if (opts?.flush) await flushChannels(state, opts.flush);
  return state;
};

export const consume: Fn = async (state: State, opts?: SetOpts) => {
  await fireDynamic(state);
  if (opts?.flush) await flushChannels(state, opts.flush);
  return state;
};

// Standalone drain — exposed so host code can drain channels without
// going through set/batch. Useful when a host orchestrator wants to
// force-commit DOM/persist work outside a set call (e.g. before tearing
// down a state, or in test setup). Defaults to draining every channel
// to fixed point. Returns Promise<void> so async drains can be awaited.
export const drain: Fn = async (state: State, spec?: FlushSpec) => {
  await flushChannels(state, spec ?? "all");
  return state;
};
