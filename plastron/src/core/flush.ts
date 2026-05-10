import type { Fn, Key, State } from "../types/index.js";
import { disposeCel } from "./hydrate.js";
import { flushChannels } from "./input.js";
import { precompute } from "./precompute.js";
import { topologicalDependentOrder } from "./segments.js";

// ============================================================================
// flush(state, segmentKey, options?) — remove every cel whose `segment`
// matches.
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
// (waveCascade, children, dynamicCascade) reflect the new graph and
// the downstream cache resets to empty. No-ops when nothing matches.
//
// Dependent-segment policy (consults state.segments):
//   • Default — refuse if any loaded segment has dependsOn[*].segment
//     === segmentKey. Throws with a message naming the dependents.
//   • cascade: true — flush dependents in topological order first
//     (leaves first), then the target. Each cascade flush is itself
//     a regular flush, so the recursion enforces the policy at every
//     level: a chain A → B → C cascade-flushed at A flushes C, then
//     B, then A.
//   • force: true — drop the dependents check entirely; the target's
//     cels and manifest go away even if dependents are still loaded.
//     Dependent segments stay in state.segments but their lambdas may
//     reference fns or schemas that just got removed from the kernel
//     registries (host responsibility to clean up afterwards). Use for
//     tests and emergency teardown.
//
// Shared celSegments cleanup (e.g. "config", "stats"): tracking which
// cel was installed by which segment isn't possible without a per-cel
// ownership field, which v1 deliberately doesn't add (would create
// ambiguity for cels that legitimately move between segments). When a
// segment's manifest declares `provides.celSegments` containing keys
// other than its own, flush walks those shared segments and removes
// only cels whose key starts with the flushing segment's key plus
// either `_` or `:` (e.g. unloading "plastron-gpu" removes
// "config_gpu" and "stats:gpu:cycles" from segments "config" and
// "stats", but leaves "config_performance" and "stats:dom:*" alone).
// Best-effort by design; documented limitation.
//
// Limitation: kebab-case prefixes are NOT matched — packages must use
// snake_case (e.g. "config_gpu") or colon-namespaced (e.g.
// "stats:gpu:cycles") cel keys to participate in shared-segment
// cleanup. A cel keyed "config-gpu" would survive a flush of
// "plastron-gpu" because `-` is not one of the recognized delimiters.
// ============================================================================

export interface FlushOptions {
  /** Flush dependent segments (transitive, leaves first) before the
   *  target. Default false. */
  cascade?: boolean;
  /** Skip the dependent-check and tear down the target even if other
   *  loaded segments still depend on it. Default false. Mutually
   *  exclusive with cascade in spirit; if both are true, cascade
   *  wins (dependents are flushed cleanly before the target). */
  force?: boolean;
}

// Recognized delimiters: `_` (snake_case, e.g. "config_gpu") and `:`
// (colon-namespaced, e.g. "stats:gpu:cycles"). Kebab-case prefixes
// (e.g. "config-gpu") are NOT matched — packages must use one of the
// recognized styles to participate in shared-segment cleanup.
const sharedCelKeyMatches = (
  celKey: Key,
  owningSegmentKey: Key,
): boolean =>
  celKey.startsWith(`${owningSegmentKey}_`) ||
  celKey.startsWith(`${owningSegmentKey}:`);

export const flush: Fn = async (
  state: State,
  segmentKey: Key,
  options: FlushOptions = {},
) => {
  const manifest = state.segments.get(segmentKey);

  // Dependent-segment policy: refuse when other manifests still
  // depend on this one, unless cascade or force is set.
  const dependents: Key[] = [];
  for (const [k, m] of state.segments) {
    if (k === segmentKey) continue;
    if (m.dependsOn?.some((d) => d.segment === segmentKey)) {
      dependents.push(k);
    }
  }
  if (dependents.length > 0 && !options.cascade && !options.force) {
    throw new Error(
      `flush "${segmentKey}": dependent segments still loaded: ` +
      dependents.join(", ") +
      `. Pass { cascade: true } to flush dependents first, ` +
      `or { force: true } to flush anyway.`,
    );
  }

  if (options.cascade) {
    // Topological order: dependents first (leaves of the dependency
    // tree are flushed before their roots). Each recursive flush
    // re-applies the dependent check at its own level.
    const order = topologicalDependentOrder(state.segments, segmentKey);
    for (const dep of order) {
      await (flush as Fn)(state, dep, { cascade: true });
    }
  }

  // Collect cels owned by this segment (its own key + any shared
  // celSegments declared in the manifest's provides). For shared
  // segments, only cels whose key prefix-matches the segment name
  // are removed (best-effort heuristic — see header comment).
  const ownedSegments = new Set<Key>([segmentKey]);
  if (manifest?.provides?.celSegments) {
    for (const cs of manifest.provides.celSegments) {
      ownedSegments.add(cs);
    }
  }

  const toRemove: Key[] = [];
  for (const cel of state.cels.values()) {
    if (cel.locked) continue;
    if (cel.segment === undefined) continue;
    if (cel.segment === segmentKey) {
      toRemove.push(cel.key);
      continue;
    }
    if (ownedSegments.has(cel.segment) &&
        sharedCelKeyMatches(cel.key, segmentKey)) {
      toRemove.push(cel.key);
    }
  }

  if (toRemove.length > 0) {
    await flushChannels(state, "all");
    for (const key of toRemove) {
      const cel = state.cels.get(key);
      if (!cel) continue;
      disposeCel(cel, state.tagRegistry);
      state.cels.delete(key);
    }
    precompute(state);
  }

  // Remove the manifest entry (idempotent if no manifest was
  // recorded). Done last so any error in the cel walk above leaves
  // the manifest in place — host can retry.
  state.segments.delete(segmentKey);

  return state;
};
