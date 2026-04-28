import type {
  DehydratedCel, FnRegistry,
} from "../state/index.js";
import type { LambdaMetadata } from "../lambdas/types/lambda.js";
import type { Key } from "../common.js";
import { createRuntime, hydrate } from "../state/index.js";
import type { 龜卜藏 } from "./types.js";
import { wrap } from "./wrap.js";

// ========================================================================
// 龜刻卜 — carve-and-divine. Hydrate from cel records, wire the write
// surface, return a fully-computed 龜卜藏. hydrate() auto-primes the
// graph so the returned object is ready to 察 on the first read.
// ========================================================================

export const 龜刻卜 = async (
  cels: Record<Key, DehydratedCel>[] = [],
  lambdas: Record<Key, LambdaMetadata>[] = [],
  fnRegistry: FnRegistry = {},
): Promise<龜卜藏> => {
  const state = await hydrate(cels, lambdas, fnRegistry);
  createRuntime(state);
  return wrap(state);
};

export { wrap } from "./wrap.js";
export type { 龜卜藏, 貞, 卜 } from "./types.js";
