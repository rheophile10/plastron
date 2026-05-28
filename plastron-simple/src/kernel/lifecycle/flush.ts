import type { Fn, Key, State } from "../../types/index.js";
import { disposeCel } from "./hydrate/cel.js";
import { flushChannels } from "../io/index.js";
import { precompute } from "../precompute/index.js";
import { computeKernelClosure, topologicalDependentOrder } from "../segments.js";

// ============================================================================
// flush(state, segmentKey, options?) — remove every cel whose `segment`
// matches.
//
// For each removed cel:
//   • fire cel._dispose (lambda-side cleanup)
//   • delete from state.cels
//
// Locked cels in the "kernel" segment are skipped — they're internal
// scaffolding (e.g. the precomputedStates seed) and shouldn't be torn
// down by a segment-level flush. Locked cels in other segments DO
// flush with their owning segment; lock protects the cel's body from
// mutation, not its segment's manifest from teardown.
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
// Dependent-segment policy (consults state.segments — Map<Key, 冊>):
//   • Default — refuse if any loaded 冊 has segmentKey in its
//     `segments` array. Throws with a message naming the dependents.
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
// Shared celSegments cleanup: tracking which cel was installed by
// which segment isn't possible without a per-cel ownership field,
// which v1 deliberately doesn't add (would create ambiguity for cels
// that legitimately move between segments). When a segment's manifest
// declares `provides.celSegments` containing keys other than its own,
// flush walks those shared segments and removes only cels whose key
// starts with the flushing segment's key plus either `_` or `:`.
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
  // Kernel-closure protection: any segment reachable from a
  // role:"kernel" segment via dependencies is part of the boot
  // kernel-set and cannot be flushed (even with `force: true`).
  // See docs/1-design/3-accepted/00-ontology/segment-classification.md
  // "Multi-segment kernel".
  const kernelSet = computeKernelClosure(state.segments);
  if (kernelSet.has(segmentKey)) {
    throw new Error(
      `flush "${segmentKey}": segment is part of the kernel closure ` +
      `(role:"kernel" or transitively depended on by one); refused.`,
    );
  }

  // Dependent-segment policy: refuse when other manifests still
  // depend on this one (their 冊.segments[] includes this segment),
  // unless cascade or force is set.
  const dependents: Key[] = [];
  for (const [k, m] of state.segments) {
    if (k === segmentKey) continue;
    if (m.dependencies.includes(segmentKey)) dependents.push(k);
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

  const ownedSegments = new Set<Key>([segmentKey]);

  const toRemove: Key[] = [];
  for (const cel of state.cels.values()) {
    // Kernel-closure protection already refused at the top guard;
    // any cel reaching this loop is in a flushable segment. We still
    // skip locked cels in kernel-closure segments defensively in case
    // a host has wired a cross-segment cel.
    if (cel.locked && cel.metadata.segment && kernelSet.has(cel.metadata.segment)) continue;
    const seg = cel.metadata.segment;
    if (seg === undefined) continue;
    if (seg === segmentKey) {
      toRemove.push(cel.metadata.key);
      continue;
    }
    if (ownedSegments.has(seg) &&
        sharedCelKeyMatches(cel.metadata.key, segmentKey)) {
      toRemove.push(cel.metadata.key);
    }
  }

  if (toRemove.length > 0) {
    await flushChannels(state, "all");
    for (const key of toRemove) {
      const cel = state.cels.get(key);
      if (!cel) continue;
      disposeCel(cel, state);
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
