import type { Fn, Key, State } from "../../types/index.js";
import { isFireable } from "../../types/index.js";
import { affectedFor, runCascade } from "../runCycle.js";
import { flushChannels, type SetOpts } from "./flush-channels.js";

// ============================================================================
// Fast-tier input fns — read and write the cel map, then fire only the
// affected subset of the cascade with change suppression so a write
// only re-runs the work that actually depends on what changed.
//
//   • set(key, value)    — fire downstream(key) ∪ dynamicCascade,
//                          seeded with [key] in `changed`
//   • batch(writes)      — fire ⋃downstream(writtenKeys) ∪ dynamicCascade,
//                          seeded with writtenKeys in `changed`
//
// Direct writes are treated as authoritative — no diff check at write
// time. Lambdas use cel._isChanged for output-side suppression.
//
// Writes to a missing cel, a locked cel, or a lambda cel throw. Reads
// of missing keys return undefined.
//
// Atomicity. set's single write is atomic by construction: validate-
// then-mutate inline, no half-state possible. batch is atomic on the
// WRITE phase: a pre-flight pass validates every write before any
// mutation, so any rejection (unknown / locked / fireable cel) throws
// with the graph untouched. Cascade-phase failures (a formula throwing
// mid-fire) are NOT rolled back — those leave the graph in a partial-
// recompute state regardless of whether the trigger was set or batch.
// ============================================================================

const validateWrite = (state: State, key: Key, label: string): void => {
  const cel = state.cels.get(key);
  if (!cel)        throw new Error(`${label}: unknown cel "${key}"`);
  if (cel.locked)  throw new Error(`${label}: cel "${key}" is locked`);
  if (isFireable(cel)) {
    throw new Error(`${label}: cel "${key}" has a compute path — use setCel`);
  }
};

const writeOne = (state: State, key: Key, value: unknown): void => {
  validateWrite(state, key, "set");
  state.cels.get(key)!.v = value;
};

export const get: Fn = (state: State, key: Key) => {
  const cel = state.cels.get(key);
  return cel ? cel.v : undefined;
};

export const set: Fn = async (
  state: State, key: Key, value: unknown, opts?: SetOpts,
) => {
  writeOne(state, key, value);
  await runCascade(state, affectedFor(state, [key]), new Set([key]));
  if (opts?.flush) await flushChannels(state, opts.flush);
  return state;
};

/** Read-transform-write convenience. Equivalent to
 *  `set(state, key, fn(get(state, key)), opts)` — sugar for the case
 *  where a cel's value is a collection (array / object) that the
 *  caller wants to modify by replacement rather than spelling out the
 *  read step. Same async / cascade semantics as `set`.
 *
 *  No different from `set` semantically: cel values are immutable from
 *  the outside; `update` just bundles the read into the call. Useful
 *  in event handlers that compute the next value from the current. */
export const update: Fn = async (
  state: State, key: Key, fn: (current: unknown) => unknown, opts?: SetOpts,
) => {
  const cel = state.cels.get(key);
  const next = fn(cel?.v);
  writeOne(state, key, next);
  await runCascade(state, affectedFor(state, [key]), new Set([key]));
  if (opts?.flush) await flushChannels(state, opts.flush);
  return state;
};

export const batch: Fn = async (
  state: State, writes: Array<[Key, unknown]>, opts?: SetOpts,
) => {
  // Atomic pre-flight — walk every write, fail-fast on any validation
  // miss before any mutation. Duplicate keys validate independently
  // (each pass is a pure read against state.cels); apply-time last-
  // write-wins is unchanged.
  for (const [k] of writes) validateWrite(state, k, "batch");

  const firedKeys: Key[] = [];
  const seen = new Set<Key>();
  for (const [k, v] of writes) {
    state.cels.get(k)!.v = v;
    if (!seen.has(k)) { seen.add(k); firedKeys.push(k); }
  }
  await runCascade(state, affectedFor(state, firedKeys), new Set(firedKeys));
  if (opts?.flush) await flushChannels(state, opts.flush);
  return state;
};
