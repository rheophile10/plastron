import type { Fn, Key, State } from "../types/index.js";
import { disposeCel } from "./hydrate.js";
import { precompute } from "./precompute.js";

// ============================================================================
// flush(state, segmentKey) — remove every cel whose `segment` matches.
//
// For each removed cel:
//   • fire cel._dispose (lambda-side cleanup)
//   • fire tag.release on cel.v (value-side cleanup)
//   • delete from state.cels
//
// Locked cels are skipped — they're managed by the kernel (e.g. the
// precomputedStates seed in segment "core") and shouldn't be torn
// down by a segment-level flush.
//
// After deletions, re-runs precompute so the topology indexes
// (waveCascade, downstream, dynamicCascade) reflect the new graph.
// No-ops when nothing matches.
// ============================================================================

export const flush: Fn = (state: State, segmentKey: Key) => {
  const toRemove: Key[] = [];
  for (const cel of state.cels.values()) {
    if (cel.segment !== segmentKey) continue;
    if (cel.locked) continue;
    toRemove.push(cel.key);
  }
  for (const key of toRemove) {
    const cel = state.cels.get(key);
    if (!cel) continue;
    disposeCel(cel, state.tagRegistry);
    state.cels.delete(key);
  }
  if (toRemove.length > 0) precompute(state);
  return state;
};
