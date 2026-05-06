export { runCycle } from "./runCycle.js";
export { makeInput } from "./input.js";
export {
  defaultIsChanged, isCelChanged, releaseValue,
  mergeCascades, mergeDynamicCascade,
} from "./cascade.js";

// Internal (not re-exported from state/index.ts): used only by hydrate
// to fire its priming cycle.
export { buildInitialCascade } from "./cascade.js";

export type { Input, Cascade, WavedCascade } from "./types.js";
export { fireHook } from "./hooks.js";
export type {
  HookSubscription, HookName,
  BeforeCycleEvent, AfterLambdaInvokeEvent, AfterWaveEvent,
  AfterCycleEvent, AfterHydrateEvent,
} from "./hooks.js";
