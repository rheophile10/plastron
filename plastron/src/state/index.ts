import type { State } from "./types/index.js";
import { runCycle } from "./cycle/runCycle.js";
import { makeInput } from "./cycle/input.js";

// ========================================================================
// createRuntime — take a hydrated State and attach the cycle runner
// (state.cycle) and the write surface (state.input). Returns the same
// State for chaining. "Runtime" is just a hydrated State with cycle +
// input wired up.
// ========================================================================

export const createRuntime = (state: State): State => {
  state.cycle = runCycle(state);
  state.input = makeInput(state);

  // Populate "input" segment method cels with references to the live
  // input surface, so lambdas can invoke set / batch / touch / consume
  // / get via inputMap.
  const inp = state.input;
  const cels = state.Cels;
  const setIfPresent = (key: string, fn: unknown) => {
    const cel = cels.get(key);
    if (cel) cel.v = fn;
  };
  setIfPresent("input_get",     inp.get.bind(inp));
  setIfPresent("input_set",     inp.set.bind(inp));
  setIfPresent("input_batch",   inp.batch.bind(inp));
  setIfPresent("input_touch",   inp.touch.bind(inp));
  setIfPresent("input_consume", inp.consume.bind(inp));

  return state;
};

// ------------------------------------------------------------------------
// Re-exports — the public state API surface.
// ------------------------------------------------------------------------

export type { State, Cel, IsChanged, Cascade, WavedCascade } from "./types/index.js";
export type { Input } from "./cycle/types.js";

export { hydrate } from "./hydration/index.js";
export type { DehydratedCel, FnRegistry, HydrateOptions } from "./hydration/index.js";

export type {
  RecalculationMode, RecalculationConfig,
  ChangeIndexConfig, ChangeIndices,
  ErrorInfo, Errors,
  TagIndex, DownstreamTopology, DynamicCascade, DynamicKeys,
  SegmentCelsIndex,
} from "./segments/types/index.js";
