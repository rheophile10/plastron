import type { Cel, Key, SegmentManifest, State } from "./types/index.js";
import { coreFns, coreFnMetadata } from "./core/index.js";
import { PRECOMPUTED_STATES_KEY, type PrecomputedIndexes } from "./core/precompute.js";

// ============================================================================
// createInitialState — return a fresh State with coreFns preinstalled,
// the precomputedStates seed cel locked, and locked metadata seeded
// for every core fn so subsequent hydrates can't overwrite them.
//
// Also seeds state.segments with a single "core" manifest declaring
// the bootstrap registry: the core fns and the locked
// precomputedStates seed cel. Hosts can introspect this via the
// `listSegments` core fn even before any user segment hydrates.
//
// Calling convention: every kernel fn receives positional args. To run
// hydrate or runCycle, pass `(state, …)`:
//
//   const state = createInitialState();
//   state.fns.get("hydrate")!(state, [mySeg], [myFns]);
//   await state.fns.get("runCycle")!(state);
// ============================================================================

const seedPrecomputedStatesCel = (): Cel => ({
  key: PRECOMPUTED_STATES_KEY,
  v: {
    waveCascade: new Map(),
    sortedWaves: [],
    children: new Map(),
    downstream: new Map(),
    dynamicCascade: new Set(),
  } satisfies PrecomputedIndexes,
  segment: "core",
  locked: true,
});

const buildCoreManifest = (): SegmentManifest => ({
  segment: "core",
  version: "1.0.0",
  description: "Kernel-internal seeds. Always present.",
  provides: {
    celSegments: ["core"],
    lambdas: Array.from(coreFns.keys()),
  },
});

export const createInitialState = (): State => {
  const cels = new Map<Key, Cel>();
  const seed = seedPrecomputedStatesCel();
  cels.set(seed.key, seed);

  const segments = new Map<Key, SegmentManifest>([
    ["core", buildCoreManifest()],
  ]);

  // coreFns and coreFnMetadata are shared across every state instance,
  // so we clone — hydrate mutates state.fns / state.fnMetadata, and we
  // don't want those mutations leaking into the canonical registry.
  return {
    cels,
    fns:                  new Map(coreFns),
    fnMetadata:           new Map(coreFnMetadata),
    schemas:              new Map(),
    schemaMetadata:       new Map(),
    tagRegistry:          new Map(),
    fnDispose:            new Map(),
    channelRegistry:      new Map(),
    precomputeGeneration: 0,
    segments,
  };
};

export type * from "./types/index.js";
export {
  getSegmentManifest, listSegments, findDependents, satisfies,
} from "./core/segments.js";
