import type { Cel, State } from "./types.js";
import type { PrecomputedIndexes } from "./core/precompute.js";
import { coreFns } from "./core/index.js";

// ============================================================================
// PRECOMPUTED_STATES_KEY — key of the locked cel that holds every
// index runCycle reads. Defined here (rather than in core/precompute)
// so initial.ts can seed the cel without a runtime cycle back into
// core. core/precompute and core/runCycle import this constant from
// here.
//
// createInitialState — return a fresh State with coreFns preinstalled
// and the precomputedStates seed cel locked. Cels (apart from the
// seed) and schemas start empty.
//
// Calling convention: every kernel fn receives an input record. To run
// hydrate or runCycle, pass `{ state, ... }`:
//
//   const state = createInitialState();
//   state.fns.get("hydrate")!.fn({ state, segments: [mySeg] });
//   await state.fns.get("runCycle")!.fn({ state });
// ============================================================================

export const PRECOMPUTED_STATES_KEY = "precomputedStates" as const;

const seedPrecomputedStatesCel = (): Cel => ({
  key: PRECOMPUTED_STATES_KEY,
  v: { waveCascade: new Map() } satisfies PrecomputedIndexes,
  segment: "core",
  locked: true,
});

export const createInitialState = (): State => {
  const cels = new Map<string, Cel>();
  const seed = seedPrecomputedStatesCel();
  cels.set(seed.key, seed);
  return {
    cels,
    fns:     new Map(Object.entries(coreFns)),
    schemas: new Map(),
  };
};
