import type { Fn, State } from "../../types/index.js";
import { PRECOMPUTED_STATES_KEY, type PrecomputedIndexes } from "../precompute/index.js";
import { runCascade } from "../runCycle.js";
import { flushChannels, type FlushSpec, type SetOpts } from "./flush-channels.js";

// ============================================================================
// touch / consume / drain — "trigger an effect" fns that don't write a cel.
//
//   • touch    — fire dynamicCascade with empty `changed` (only cels with
//                `dynamic: true` actually fire). Use to refresh clocks /
//                randoms / any cel whose value depends on time, not deps.
//   • consume  — same shape as touch. Semantic alias for "observe and
//                drain" — useful in test code or polling loops where you
//                want the intent to read on the call site.
//   • drain    — flush channels to fixed point without writing any cels.
//                Useful when a host orchestrator wants to force-commit
//                DOM / persist work outside a set call (e.g. before
//                tearing down a state, or in test setup).
// ============================================================================

const fireDynamic = async (state: State): Promise<void> => {
  const indexes = state.cels.get(PRECOMPUTED_STATES_KEY)?.v as PrecomputedIndexes | undefined;
  if (indexes) await runCascade(state, indexes.dynamicCascade, new Set());
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

export const drain: Fn = async (state: State, spec?: FlushSpec) => {
  await flushChannels(state, spec ?? "all");
  return state;
};
