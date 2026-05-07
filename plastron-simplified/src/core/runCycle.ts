import type { Fn, State } from "../types.js";
import type { PrecomputedIndexes } from "./precompute.js";
import { PRECOMPUTED_STATES_KEY } from "../initial.js";

// ============================================================================
// runCycle — read the precomputed waveCascade out of the locked
// precomputedStates cel, then iterate waves in order and the
// topo-sorted keys within each wave, invoking each lambda cel's fn
// with inputs gathered from its inputMap.
// ============================================================================

export const runCycle: Fn = async (state: State) => {
  const cels = state.cels;
  const fns = state.fns;

  const indexes = cels.get(PRECOMPUTED_STATES_KEY)?.v as PrecomputedIndexes | undefined;
  if (!indexes) return state;

  const waves = [...indexes.waveCascade.keys()].sort((a, b) => a - b);
  for (const wave of waves) {
    const keys = indexes.waveCascade.get(wave)!;
    for (const key of keys) {
      const cel = cels.get(key);
      if (!cel || !cel.l) continue;
      const fn = fns.get(cel.l);
      if (!fn) continue;

      const inputs: Record<string, unknown> = {};
      if (cel.inputMap) {
        for (const [name, ref] of Object.entries(cel.inputMap)) {
          inputs[name] = Array.isArray(ref)
            ? ref.map((k) => cels.get(k)?.v)
            : cels.get(ref)?.v;
        }
      }
      cel.v = await Promise.resolve(fn(inputs));
    }
  }
  return state;
};
