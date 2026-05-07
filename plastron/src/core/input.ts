import type { Fn, Key, State } from "../types/index.js";
import { PRECOMPUTED_STATES_KEY, type PrecomputedIndexes } from "./precompute.js";
import { releaseValue } from "./hydrate.js";
import { affectedFor, runCascade } from "./runCycle.js";

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

export const set: Fn = async (state: State, key: Key, value: unknown) => {
  writeOne(state, key, value);
  await runCascade(state, affectedFor(state, [key]), new Set([key]));
  return state;
};

export const batch: Fn = async (state: State, writes: Array<[Key, unknown]>) => {
  const writtenKeys = writes.map(([k]) => k);
  for (const [k, v] of writes) writeOne(state, k, v);
  await runCascade(state, affectedFor(state, writtenKeys), new Set(writtenKeys));
  return state;
};

export const touch: Fn = async (state: State) => {
  await fireDynamic(state);
  return state;
};

export const consume: Fn = async (state: State) => {
  await fireDynamic(state);
  return state;
};
