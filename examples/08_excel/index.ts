// ============================================================================
// EXAMPLE 08 — MS-Excel-themed formula parser.
//
// HOW TO RUN:
//   npx vite-node examples/08_excel/index.ts
//
// WHAT THIS DEMONSTRATES:
//   A custom formula parser registered alongside the default Polish-
//   notation one. We swap it in globally by setting the
//   `config_recalculation.formulaParser` cel to our lambda's key.
//
//   Every formula cel now parses with Excel syntax:
//
//     =A1+B1               arithmetic (+, -, *, /)
//     =A1=5                comparisons (=, <>, <, >, <=, >=)
//     =A1&B1               string concat
//     =SUM(A1, A2, A3)     function calls (variadic)
//     =IF(A1>10, "big", "small")
//     =AVERAGE(A1, A2, A3)
//     =ROUND(A1)
//     =LEN(name)
//
//   Cell keys look like "A1", "B2" to match Excel's A1 notation, but
//   any identifier works — the parser treats unknown identifiers as
//   cell references.
// ============================================================================

import { runtime } from "../../plastron/src/index.js";
import type {
  DehydratedCel, LambdaMetadata, FnRegistry,
} from "../../plastron/src/state/index.js";
import { excel, excelMeta } from "./parser.js";

// ============================================================================
// A tiny "spreadsheet" — column A holds prices, column B holds
// quantities, column C computes row totals, and the bottom row
// computes aggregates.
//
// Every derived cel uses `f` (formula), which is dispatched to our
// Excel parser because we override the formulaParser config.
// ============================================================================

const cels: Record<string, DehydratedCel> = {
  // Prices
  A1: { segment: "sheet", v: 10 },
  A2: { segment: "sheet", v: 15 },
  A3: { segment: "sheet", v: 20 },

  // Quantities
  B1: { segment: "sheet", v: 2 },
  B2: { segment: "sheet", v: 1 },
  B3: { segment: "sheet", v: 4 },

  // Per-row totals
  C1: { segment: "sheet", f: "=A1*B1" },
  C2: { segment: "sheet", f: "=A2*B2" },
  C3: { segment: "sheet", f: "=A3*B3" },

  // Aggregates
  subtotal:  { segment: "sheet", f: "=SUM(C1, C2, C3)" },
  avgPrice:  { segment: "sheet", f: "=AVERAGE(A1, A2, A3)" },
  maxQty:    { segment: "sheet", f: "=MAX(B1, B2, B3)" },

  // Conditional display
  rating:    { segment: "sheet", f: "=IF(subtotal>=100, \"big order\", \"small order\")" },

  // String composition
  label:     { segment: "sheet", v: "Order: " },
  summary:   { segment: "sheet", f: "=label&subtotal&\" (\"&rating&\")\"" },
};

const lambdaMeta: Record<string, LambdaMetadata> = {
  excel: excelMeta,
};
const fnRegistry: FnRegistry = { excel };

// ============================================================================
// Boot with the Excel parser. We need to tell the engine to dispatch
// formula cels to the "excel" lambda instead of the default "f" parser.
// That's done by mutating the `config_recalculation` cel's v before the
// initial hydrate's formula-expansion step runs.
//
// Since config_recalculation is a reserved cel that's already present
// by the time we'd normally call runtime(), we need a two-step boot:
//   1. runtime([]) — creates an empty runtime with config cels present.
//   2. set config_recalculation.formulaParser = "excel".
//   3. hydrate the sheet cels — they'll dispatch to our Excel parser.
// ============================================================================

// Step 1: empty boot.
const rt = await runtime();

// Step 2: swap the default formula parser.
const recalcCfg = rt.Cels.get("config_recalculation")!;
recalcCfg.v = {
  ...(recalcCfg.v as object),
  formulaParser: "excel",
};

// Step 3: hydrate the sheet. Excel formulas now route through our parser.
await rt.hydrate([cels], [lambdaMeta], fnRegistry);

// Drop the helloWorld bootstrapped cels that runtime() seeded by default,
// so the display focuses on the spreadsheet.
rt.flush("helloWorld");

// ============================================================================
// Display. Sorted for readability.
// ============================================================================

const show = (label: string) => {
  console.log(`\n--- ${label} ---`);
  const rows = [
    ["A1", "A2", "A3"],
    ["B1", "B2", "B3"],
    ["C1", "C2", "C3"],
  ];
  for (const [heading, row] of [["price", rows[0]], ["qty", rows[1]], ["C (A*B)", rows[2]]] as const) {
    const vals = row.map(k => String(rt.input!.get(k)).padStart(4)).join(" | ");
    console.log(`  ${heading.padEnd(8)} │ ${vals}`);
  }
  console.log(`  subtotal = ${rt.input!.get("subtotal")}`);
  console.log(`  avgPrice = ${rt.input!.get("avgPrice")}`);
  console.log(`  maxQty   = ${rt.input!.get("maxQty")}`);
  console.log(`  rating   = ${rt.input!.get("rating")}`);
  console.log(`  summary  = ${rt.input!.get("summary")}`);
};

show("After boot");

// ============================================================================
// Edit cells like you'd edit a spreadsheet.
// ============================================================================

console.log("\nEditing A1 = 25, B3 = 10 …");
await rt.input!.batch([
  ["A1", 25],
  ["B3", 10],
]);
show("After edit");

console.log("\nEditing A1 back down to 5, subtotal should drop below 100 →");
await rt.input!.set("A1", 5);
show("After A1 = 5");

// ============================================================================
// TAKEAWAY
//
// * Custom formula parsers are just lambdas. Attach `extractDeps` as a
//   property on the fn so hydrate can auto-wire dependencies.
// * The `config_recalculation.formulaParser` cel controls which lambda
//   handles cel.f. Set it before hydrating any formula cels.
// * Operator aliases (🔄, 🆔) live in `config_opAliases` and belong to
//   the default parser; your custom parser can read them via the
//   _read("config_opAliases") escape hatch if it wants to share them.
// ============================================================================
