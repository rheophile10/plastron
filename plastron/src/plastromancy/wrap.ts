import type { State } from "../state/index.js";
import type { 龜卜藏, 貞 } from "./types.js";

// ========================================================================
// wrap — proxy a plain State as a 龜卜藏. Thin rebinding of methods
// under Chinese names. All three — 辛, 貞, 增 — are getters so they stay
// live through incremental hydrate calls.
// ========================================================================

export const wrap = (state: State): 龜卜藏 => {
  const bound = {
    骨: state.Cels,
    焚: state.flush,
    // 增 — incremental hydrate. Returns a wrapped 龜卜藏 so you can chain.
    增: async (
      cels: Parameters<State["hydrate"]>[0],
      lambdas?: Parameters<State["hydrate"]>[1],
      fnRegistry?: Parameters<State["hydrate"]>[2],
      options?: Parameters<State["hydrate"]>[3],
    ) => {
      await state.hydrate(cels, lambdas, fnRegistry, options);
      return bound;
    },
    get 辛() { return state.cycle; },
    get 貞() {
      return state.input ? wrapInput(state.input) : undefined;
    },
  } as 龜卜藏;

  return bound;
};

const wrapInput = (input: NonNullable<State["input"]>): 貞 => ({
  察:   input.get.bind(input),
  刻:   input.set.bind(input),
  連刻: input.batch.bind(input),
  重:   input.touch.bind(input),
  施:   input.consume.bind(input),
  get 卜() { return input.buffer; },
} as 貞);
