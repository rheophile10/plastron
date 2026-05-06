import type { Key } from "../../../../plastron/src/common.js";
import type {
  DehydratedCel, FnRegistry, HydrateOptions,
} from "../../../../plastron/src/state/index.js";
import type { LambdaMetadata } from "../../../../plastron/src/lambdas/types/lambda.js";
import { hydrate, hydrateBundles, createRuntime } from "../../../../plastron/src/state/index.js";
import { installAllDefaults } from "../../../../plastron/src/segments/defaults/index.js";
import { wrap } from "./wrap.js";
import type { 龜卜藏, 卷 } from "./types.js";

// ========================================================================
// 龜刻卜 — carve and divine. Two entry points wrapped under one name:
//
//   龜刻卜(cels, lambdas, fnRegistry, options)
//     The legacy English-shaped hydrate path: arrays of cel records,
//     arrays of lambda metadata, an fn registry. Returns a fully-primed
//     龜卜藏 ready to 察.
//
//   龜刻卜.卷(bundles, fnRegistry, options)
//     The bundle-shaped path. Each 卷 (SegmentBundle) carries its own
//     cels, lambdas, aliases, segment metadata, and optional 印
//     (manifest). When a 印 is present, options.verifySegment is
//     consulted; default behaviour accepts everything.
// ========================================================================

export const 龜刻卜 = async (
  cels: Record<Key, DehydratedCel>[] = [],
  lambdas: Record<Key, LambdaMetadata>[] = [],
  fnRegistry: FnRegistry = {},
  options?: HydrateOptions,
): Promise<龜卜藏> => {
  const state = await hydrate(cels, lambdas, fnRegistry, undefined, options);
  createRuntime(state);
  if (options?.installDefaults !== false) {
    await installAllDefaults(state);
  }
  return wrap(state);
};

/** 龜刻卜.卷 — bundle-shaped variant. */
龜刻卜.卷 = async (
  bundles: 卷[],
  fnRegistry: FnRegistry = {},
  options?: HydrateOptions,
): Promise<龜卜藏> => {
  const state = await hydrateBundles(bundles, fnRegistry, undefined, options);
  createRuntime(state);
  if (options?.installDefaults !== false) {
    await installAllDefaults(state);
  }
  return wrap(state);
};

export { wrap } from "./wrap.js";
export type { 龜卜藏, 貞, 卜, 卷, 印, 體, 紋 } from "./types.js";
