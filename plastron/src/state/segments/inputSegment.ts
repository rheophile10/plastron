import type { Cel } from "../types/cel.js";

// ========================================================================
// Segment "input" — cels exposing the Input write+read methods as
// readable function values. Lambdas can reference these via inputMap
// to invoke set / batch / touch / etc. from inside a cycle.
//
// The `.v` of each cel is populated by createRuntime after makeInput().
// ========================================================================

const inputGet: Cel = {
  key: "input_get",
  name: "input.get",
  description: "(key) → unknown. Read a cel's value.",
  v: null,
  children: [],
  segment: "input",
  readOnly: true,
};

const inputSet: Cel = {
  key: "input_set",
  name: "input.set",
  description: "(key, value) → Promise<void>. Single write; one cycle.",
  v: null,
  children: [],
  segment: "input",
  readOnly: true,
};

const inputBatch: Cel = {
  key: "input_batch",
  name: "input.batch",
  description: "([key, value][]) → Promise<void>. Merged writes; one cycle.",
  v: null,
  children: [],
  segment: "input",
  readOnly: true,
};

const inputTouch: Cel = {
  key: "input_touch",
  name: "input.touch",
  description: "(key) → Promise<void>. Re-fire cel + downstream.",
  v: null,
  children: [],
  segment: "input",
  readOnly: true,
};

const inputConsume: Cel = {
  key: "input_consume",
  name: "input.consume",
  description: "() → Promise<void>. Drain the pending buffer.",
  v: null,
  children: [],
  segment: "input",
  readOnly: true,
};

export const inputMethodCells: Cel[] = [
  inputGet,
  inputSet,
  inputBatch,
  inputTouch,
  inputConsume,
];
