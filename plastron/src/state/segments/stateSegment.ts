import type { Cel } from "../types/cel.js";

// ========================================================================
// Segment "state" — cels that expose State's own methods as readable
// values. Lambdas that need to flush a segment or hydrate a new one can
// reference these via inputMap and invoke the functions they hold.
//
// The `.v` of each cel is populated at runtime:
//   state_hydrate  — set by hydrate() bootstrap  (closes over state)
//   state_flush    — set by hydrate() bootstrap
// ========================================================================

const stateHydrate: Cel = {
  key: "state_hydrate",
  name: "state.hydrate",
  description: "(cels, lambdas?, fnRegistry?, options?) → Promise<State>. Incremental hydrate.",
  v: null,
  children: [],
  segment: "state",
  readOnly: true,
};

const stateFlush: Cel = {
  key: "state_flush",
  name: "state.flush",
  description: "(segmentKey) → void. Remove every cel whose segment matches.",
  v: null,
  children: [],
  segment: "state",
  readOnly: true,
};

export const stateMethodCells: Cel[] = [
  stateHydrate,
  stateFlush,
];
