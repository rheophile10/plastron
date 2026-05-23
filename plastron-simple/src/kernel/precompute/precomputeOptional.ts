import type {
  Cel, Channel, ResolvedInputs, State,
} from "../../types/index.js";
import { isFireable } from "../../types/index.js";
import { CSP_EVAL_AVAILABLE_KEY } from "../../甲骨坑/csp.js";
import { PRECOMPUTED_STATES_KEY, type PrecomputedIndexes } from "./precompute.js";

const OPTIONAL_CHUNK_SIZE = 256;

export const precomputeOptional = async (state: State): Promise<void> => {
  const myGen = state.precomputeGeneration;
  const cels = state.cels;
  const allCels = [...cels.values()];
  const indexes = cels.get(PRECOMPUTED_STATES_KEY)?.v as PrecomputedIndexes | undefined;
  // Captured once per precompute pass. Default true if the csp segment
  // isn't loaded (preserves the pre-CSP-cel behavior of attempting the
  // codegen path and falling back via try/catch only on actual failure).
  const cspEvalAvailable =
    (cels.get(CSP_EVAL_AVAILABLE_KEY)?.v as boolean | undefined) ?? true;

  for (let i = 0; i < allCels.length; i += OPTIONAL_CHUNK_SIZE) {
    if (state.precomputeGeneration !== myGen) return;

    const end = Math.min(i + OPTIONAL_CHUNK_SIZE, allCels.length);
    for (let j = i; j < end; j++) {
      if (state.precomputeGeneration !== myGen) return;
      const cel = allCels[j];
      if (!isFireable(cel)) continue;

      try {
        const inputMap = cel.metadata.inputMap;
        if (inputMap) {
          const entries: Array<[string, Cel | undefined | Array<Cel | undefined>]> = [];
          for (const [name, ref] of Object.entries(inputMap)) {
            if (Array.isArray(ref)) {
              entries.push([name, ref.map((k) => cels.get(k))]);
            } else {
              entries.push([name, cels.get(ref)]);
            }
          }
          if (state.precomputeGeneration !== myGen) return;
          cel._inputEntries = entries;
        }

        const channels = cel.metadata.channel;
        if (channels && channels.length > 0) {
          const handlers: Channel[] = [];
          for (const k of channels) {
            const channelCel = indexes?.channels.get(k);
            if (channelCel?._channel) handlers.push(channelCel._channel);
          }
          if (state.precomputeGeneration !== myGen) return;
          cel._channelHandlers = handlers.length > 0 ? handlers : undefined;
        }

        if (cel._buildEvaluate && cel._inputEntries) {
          const inputs: ResolvedInputs = {};
          for (const [name, cs] of cel._inputEntries) {
            inputs[name] = cs;
          }
          const result = cel._buildEvaluate(inputs, cspEvalAvailable);
          if (result instanceof Promise) {
            const resolved = await result;
            if (state.precomputeGeneration !== myGen) return;
            cel._evaluate = resolved;
          } else {
            cel._evaluate = result;
          }
        }
      } catch {
        cel._evaluate = undefined;
      }
    }

    if (end < allCels.length) {
      if (state.precomputeGeneration !== myGen) return;
      await Promise.resolve();
    }
  }
};
