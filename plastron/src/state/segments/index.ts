import { configCells } from "./config.js";
import { indexCells } from "./indexes.js";
import { stateMethodCells } from "./stateSegment.js";
import { inputMethodCells } from "./inputSegment.js";

// ========================================================================
// All default reserved cels, across the runtime-owned segments:
//   "config"  — user-tunable defaults + runtime bookkeeping
//   "indexes" — derived graph data (populated by precompute)
//   "state"   — State-level method references (state.hydrate, state.flush)
//   "input"   — Input-level method references (get / set / batch / …)
// ========================================================================

export const defaultCells = [
  ...configCells,
  ...indexCells,
  ...stateMethodCells,
  ...inputMethodCells,
];
