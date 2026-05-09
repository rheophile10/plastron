import type { ChannelKey, Fn, Key, State } from "../types/index.js";
import { PRECOMPUTED_STATES_KEY, type PrecomputedIndexes } from "./precompute.js";
import { releaseValue } from "./hydrate.js";
import { affectedFor, runCascade } from "./runCycle.js";

// ----------------------------------------------------------------------------
// Channel flush — drain pending channel work synchronously.
//
//   spec === undefined | 'none'    no flush
//   spec === 'all'                 fixed-point drain over every channel
//   spec is a ChannelKey           sync-flush that one channel
//
// Fixed-point drain handles channel commits that re-enter the graph via
// set/batch: a commit may trigger a new cascade that enqueues to other
// channels. We loop until no channel has pending work. Capped at
// FLUSH_MAX_ITERATIONS to surface runaway feedback as an error rather
// than hang.
// ----------------------------------------------------------------------------

export type FlushSpec = ChannelKey | "all" | "none";

const FLUSH_MAX_ITERATIONS = 64;

export const flushChannels = (state: State, spec: FlushSpec | undefined): void => {
  if (!spec || spec === "none") return;
  if (spec === "all") {
    let iterations = 0;
    let progress = true;
    while (progress) {
      if (++iterations > FLUSH_MAX_ITERATIONS) {
        throw new Error(
          `flushChannels: exceeded ${FLUSH_MAX_ITERATIONS} iterations — ` +
          `channels may be in a feedback loop (commit triggers cascade ` +
          `that re-enqueues the same channel).`,
        );
      }
      progress = false;
      for (const ch of state.channelRegistry.values()) {
        if (ch.hasPending()) {
          ch.flushSync();
          progress = true;
        }
      }
    }
    return;
  }
  state.channelRegistry.get(spec)?.flushSync();
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
  flushChannels(state, opts?.flush);
  return state;
};

export const batch: Fn = async (
  state: State, writes: Array<[Key, unknown]>, opts?: SetOpts,
) => {
  const writtenKeys = writes.map(([k]) => k);
  for (const [k, v] of writes) writeOne(state, k, v);
  await runCascade(state, affectedFor(state, writtenKeys), new Set(writtenKeys));
  flushChannels(state, opts?.flush);
  return state;
};

export const touch: Fn = async (state: State, opts?: SetOpts) => {
  await fireDynamic(state);
  flushChannels(state, opts?.flush);
  return state;
};

export const consume: Fn = async (state: State, opts?: SetOpts) => {
  await fireDynamic(state);
  flushChannels(state, opts?.flush);
  return state;
};

// Standalone flush — exposed so host code can drain channels without
// going through set/batch. Useful when a host orchestrator wants to
// force-commit DOM/persist work outside a set call (e.g. before tearing
// down a state, or in test setup).
export const flushSync: Fn = (state: State, spec?: FlushSpec) => {
  flushChannels(state, spec ?? "all");
  return state;
};
