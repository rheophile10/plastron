// ============================================================================
// EXAMPLE 01 — runtime() → observe reactive recalculation.
//
// HOW TO RUN (from /home/ian/projects/plastron):
//   npx vite-node examples/01_addition_chain/index.ts
//
// WHAT THIS FILE DOES:
//   1. Starts with a JSON string describing a small spreadsheet-like graph:
//          c     = a + b
//          e     = c * factor
//          total = c + e
//   2. Parses the JSON, boots a runtime via the top-level runtime() helper.
//   3. Reads values, changes variables, watches recalc propagate.
//
// MENTAL MODEL:
//   Runtime = Excel. Variables (a, b) are editable cells. Lambdas (c, e,
//   total) are cells with formulas. Change an input, everything downstream
//   recomputes.
// ============================================================================

import { runtime as createRuntime } from "../../plastron/src/index.js";
import type { DehydratedCel } from "../../plastron/src/state/index.js";

// ============================================================================
// STEP 1 — The graph as JSON. Each cel carries its segment key.
//
// Roles are expressed by optional fields:
//   variable:   v, children
//   constant:   v, children, readOnly: true
//   lambda:     l, inputMap, children  (v computed at recalc)
//
// `children` (downstream) and `inputMap` (upstream) describe the same
// edges; hydrate auto-wires children from inputMap, so you only need one.
// ============================================================================

const graphJson = `{
  "a":      { "segment": "demo", "v": 3 },
  "b":      { "segment": "demo", "v": 4 },
  "factor": { "segment": "demo", "v": 10, "readOnly": true },

  "c":      { "segment": "demo", "l": "add",
              "inputMap": { "a": "a", "b": "b" } },

  "e":      { "segment": "demo", "l": "multiply",
              "inputMap": { "a": "c", "b": "factor" } },

  "total":  { "segment": "demo", "l": "add",
              "inputMap": { "a": "c", "b": "e" } }
}`;

// ============================================================================
// STEP 2 — Parse the JSON, boot the runtime. runtime() hydrates and
// fires an initial cycle so lambda cels have their values on first read.
// ============================================================================

const cels = JSON.parse(graphJson) as Record<string, DehydratedCel>;
const rt = await createRuntime([cels]);

// ============================================================================
// STEP 3 — Inspect, write, observe cascades.
// ============================================================================

const show = (label: string) => {
  console.log(`\n--- ${label} ---`);
  for (const key of ["a", "b", "factor", "c", "e", "total"]) {
    console.log(`  ${key.padEnd(6)} = ${rt.input!.get(key)}`);
  }
};

show("Right after load (primed by hydrate)");

console.log("\nSetting a = 10...");
await rt.input!.set("a", 10);
show("After a=10");

console.log("\nBatching a=1, b=2 in one call...");
await rt.input!.batch([
  ["a", 1],
  ["b", 2],
]);
show("After batch");

console.log("\nTrying to set the constant 'factor' (should throw)...");
try {
  await rt.input!.set("factor", 99);
} catch (err) {
  console.log("  Rejected as expected:", (err as Error).message);
}
