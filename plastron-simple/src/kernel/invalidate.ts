import type { ComputeCel, Key, State } from "../types/index.js";
import { PRECOMPUTED_STATES_KEY, type PrecomputedIndexes } from "./precompute/index.js";

// ============================================================================
// invalidate(state, defKey) — definition-change cache teardown.
//
// When an EditableLambdaCel's _fn is replaced, a SchemaCel's v is
// swapped (changing isChanged/dehydrate/memoSafe protocols), or a
// CompilerCel's body changes, every downstream cel that depends on it
// has stale cache entries: those outputs were computed with the old
// fn/protocols.
//
// Called from setCel and registerLambda after the write commits. Walks
// the precompute usage indexes (lambdaUsage, schemaUsage) to find
// consumers and clears their _memoCache. The changed cel's own
// _memoCache is also cleared.
//
// Returns the set of consumer keys so callers can drive a cascade
// against them (setCel already does this via expandUsageSeeds +
// runCascade — same source set).
//
// Note on _evaluate: FormulaCel codegen emits live reads
// `(c0._fn ?? c0.v)` so an upstream lambda's _fn change is visible
// immediately at the next fire — _evaluate doesn't need rebuilding.
// _memoCache is the only stale-on-definition-change artifact.
// ============================================================================

export const invalidate = (state: State, defKey: Key): Key[] => {
  // 1. Clear the changed cel's own _memoCache (its cached outputs
  //    were produced by code that no longer exists).
  const self = state.cels.get(defKey) as ComputeCel | undefined;
  if (self?._memoCache) self._memoCache.clear();

  // 2. Walk usage maps for downstream consumers.
  const indexes = state.cels.get(PRECOMPUTED_STATES_KEY)?.v as
    | PrecomputedIndexes | undefined;
  if (!indexes) return [];

  const consumers = new Set<Key>();
  const lu = indexes.lambdaUsage.get(defKey);
  if (lu) for (const k of lu) consumers.add(k);
  const su = indexes.schemaUsage.get(defKey);
  if (su) for (const k of su) consumers.add(k);

  // 3. Clear each consumer's _memoCache.
  for (const k of consumers) {
    const c = state.cels.get(k) as ComputeCel | undefined;
    if (c?._memoCache) c._memoCache.clear();
  }

  return [...consumers];
};
