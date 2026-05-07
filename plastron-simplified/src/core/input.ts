import type { Fn, Key, State } from "../types.js";
import { runCycle } from "./runCycle.js";

// ============================================================================
// Standard input fns — read and write the cel map, triggering a fresh
// runCycle on each write so downstream lambdas pick up changes.
//
// Writes to a missing cel, a locked cel, or a lambda cel throw. Reads
// of missing keys return undefined.
//
// Touch and consume are kept as separate entry points for parity with
// the conventional input surface; in the simplified kernel both just
// re-fire the cycle (there is no buffer / dirty-set machinery).
// ============================================================================

const writeOne = (state: State, key: Key, value: unknown): void => {
  const cel = state.cels.get(key);
  if (!cel)        throw new Error(`set: unknown cel "${key}"`);
  if (cel.locked)  throw new Error(`set: cel "${key}" is locked`);
  if (cel.l)       throw new Error(`set: cel "${key}" is a lambda — cannot write directly`);
  cel.v = value;
};

export const get: Fn = (state: State, key: Key) => {
  return state.cels.get(key)?.v;
};

export const set: Fn = async (state: State, key: Key, value: unknown) => {
  writeOne(state, key, value);
  return await runCycle({ state });
};

export const batch: Fn = async (state: State, writes: Array<[Key, unknown]>) => {
  for (const [key, value] of writes) writeOne(state, key, value);
  return await runCycle({ state });
};

export const touch: Fn = async (state: State) => {
  return await runCycle({ state });
};

export const consume: Fn = async (state: State) => {
  return await runCycle({ state });
};
