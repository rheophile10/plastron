import type { LambdaKey, Fn } from "../types.js";
import { hydrate, dehydrate } from "./hydrate.js";
import { runCycle } from "./runCycle.js";
import { get, set, batch, touch, consume } from "./input.js";

// ============================================================================
// coreFns — the default fn registry. Seeded into every initial state.
//
// Bare functions, not records: state.fns is Map<LambdaKey, Fn>, and the
// locked-protection concern moves to lambda metadata (when wired up).
//
// precompute is intentionally absent: hydrate calls it directly and it
// never enters the registry.
// ============================================================================

export const coreFns: Map<LambdaKey, Fn> = new Map([
  ["get", get],
  ["set", set],
  ["batch", batch],
  ["touch", touch],
  ["consume", consume],
  ["runCycle", runCycle],
  ["hydrate", hydrate],
  ["dehydrate", dehydrate],
]);
