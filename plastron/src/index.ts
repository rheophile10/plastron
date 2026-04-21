import { 龜刻卜 } from "./plastronomy/index.js";
import type { 龜卜藏 } from "./plastronomy/index.js";
import { createRuntime, hydrate } from "./state/index.js";
import type { DehydratedCel, FnRegistry, State } from "./state/index.js";
import type { LambdaMetadata } from "./lambdas/types/lambda.js";
import type { Key } from "./common.js";

// ============================================================================
// plastron / runtime — the two top-level helpers.
//
//   plastron()   → a 龜卜藏 (plastronomy face, Chinese methods).
//   runtime()    → a plain State (English methods).
//
// Both are async; hydrate primes the graph automatically, so the
// returned object is fully computed — no caller-side priming.
//
// Both accept three bundles:
//   cels       — arrays of Record<Key, DehydratedCel>. One record per
//                segment is typical; multiple records hydrate together.
//                Load from JSON yourself via JSON.parse if that's your
//                source format.
//   lambdas    — arrays of LambdaMetadata records for any custom lambdas.
//   fnRegistry — actual fn implementations, keyed by lambda key.
//
// For direct low-level access, import from "plastron/state".
// ============================================================================

const helloWorldCels = (): Record<string, DehydratedCel> => {
  const today = new Date().toISOString().slice(0, 10);
  return {
    name:    { key: "name",    segment: "helloWorld", v: "World" },
    date:    { key: "date",    segment: "helloWorld", v: today },
    welcome: {
      key: "welcome",
      segment: "helloWorld",
      f: "'hello ' |> concat(@name) |> concat(', welcome to plastron on ') |> concat(@date)",
    },
  };
};

const plastron = (
  cels: Record<Key, DehydratedCel>[] = [helloWorldCels()],
  lambdas: Record<Key, LambdaMetadata>[] = [],
  fnRegistry: FnRegistry = {},
): Promise<龜卜藏> => 龜刻卜(cels, lambdas, fnRegistry);

export const runtime = async (
  cels: Record<Key, DehydratedCel>[] = [helloWorldCels()],
  lambdas: Record<Key, LambdaMetadata>[] = [],
  fnRegistry: FnRegistry = {},
): Promise<State> => {
  const state = await hydrate(cels, lambdas, fnRegistry);
  return createRuntime(state);
};

export default plastron;
export { 龜刻卜 } from "./plastronomy/index.js";
export type { 龜卜藏, 貞 } from "./plastronomy/index.js";
