import type { Fn, Key, State } from "../types/index.js";
import { disposeCel } from "./hydrate.js";
import { flushChannels } from "./input.js";
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
// Channels are drained to fixed point before any cel is deleted.
// A channel queue may hold {cel, state} for a soon-to-be-removed cel;
// committing afterwards would (a) keep that cel object alive past
// deletion and (b) produce a write for a cel no longer in state.cels.
// Channel handlers themselves are NOT disposed — they're keyed
// globally, may be shared by other segments, and are the host's to
// register and tear down.
//
// After deletions, re-runs precompute so the topology indexes
// (waveCascade, downstream, dynamicCascade) reflect the new graph.
// No-ops when nothing matches.
// ============================================================================

export const flush: Fn = async (state: State, segmentKey: Key) => {
  const toRemove: Key[] = [];
  for (const cel of state.cels.values()) {
    if (cel.segment !== segmentKey) continue;
    if (cel.locked) continue;
    toRemove.push(cel.key);
  }
  if (toRemove.length === 0) return state;
  await flushChannels(state, "all");
  for (const key of toRemove) {
    const cel = state.cels.get(key);
    if (!cel) continue;
    disposeCel(cel, state.tagRegistry);
    state.cels.delete(key);
  }
  precompute(state);
  return state;
};
