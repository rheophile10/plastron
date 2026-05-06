import type { State, FnRegistry, HydrateOptions, HookSubscription } from "../../../../plastron/src/state/index.js";
import { hydrateBundles } from "../../../../plastron/src/state/index.js";
import { fingerprint, fingerprintComponents } from "../../../../plastron/src/state/fingerprint.js";
import type { 龜卜藏, 貞, 卷 } from "./types.js";

// ========================================================================
// wrap — proxy a plain State as a 龜卜藏. Thin rebinding of methods
// under Chinese names. All getter-style fields stay live across
// incremental hydrate calls.
// ========================================================================

export const wrap = (state: State): 龜卜藏 => {
  const bound = {
    骨: state.Cels,
    焚: state.flush,

    增: async (
      cels: Parameters<State["hydrate"]>[0],
      lambdas?: Parameters<State["hydrate"]>[1],
      fnRegistry?: Parameters<State["hydrate"]>[2],
      options?: Parameters<State["hydrate"]>[3],
    ) => {
      await state.hydrate(cels, lambdas, fnRegistry, options);
      return bound;
    },

    增卷: async (
      bundles: 卷[],
      fnRegistry?: FnRegistry,
      options?: HydrateOptions,
    ) => {
      await hydrateBundles(bundles, fnRegistry ?? {}, state, options);
      return bound;
    },

    觀: (subscription: HookSubscription) => {
      state._hooks = [...(state._hooks ?? []), subscription];
    },

    印鑑: () => fingerprint(state),
    印鑑分解: () => fingerprintComponents(state),

    get 辛() { return state.cycle; },
    get 貞() { return state.input ? wrapInput(state.input) : undefined; },

    __state: state,
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
