// ============================================================================
// collections-demo — packs twelve scalar cels into a single Column cel,
// runs columnSum, builds a 12-row Table from three packed columns, and
// prints a memory comparison.
//
// Reads top-to-bottom as a "how do I use plastron-collections?" guide.
// ============================================================================

import type { Fn, Segment, State } from "../../../plastron/src/index.js";
import { createInitialState } from "../../../plastron/src/index.js";
import {
  COLUMN_SCHEMA_KEY,
  COLUMN_SUM_KEY,
  TABLE_SCHEMA_KEY,
  installCollections,
  type Column,
  type Table,
} from "../../../segments/plastron-collections/src/index.js";
import {
  columnFrom, tableFrom,
} from "../../../segments/plastron-collections/src/builders.js";

// ── Boot ───────────────────────────────────────────────────────────────────

const state: State = createInitialState();
installCollections(state);

const hydrate  = state.fns.get("hydrate")  as Fn;
const runCycle = state.fns.get("runCycle") as Fn;
const get      = state.fns.get("get")      as Fn;

// ── Two parallel layouts: scalar cels vs packed Column cel ────────────────
//
// Scalar layout — twelve individual `monthly_<m>` cels, each holding a
// single number. This is the "before" picture: per-cel kernel overhead
// (segment, schema slot, etc.) dominates the actual data cost.
//
// Packed layout — one `salesColumn` cel whose lambda packs the twelve
// scalars into a typed array. Downstream `salesTotal` reads the column
// and runs `columnSum`. Twelve numbers worth of data, one cel of
// overhead.

const monthValues = [
  100, 110, 130, 90, 140, 160,
  170, 180, 200, 175, 150, 220,
];
const monthKeys = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
] as const;

const scalarCels: Segment["cels"] = monthKeys.map((k, i) => ({
  key: `monthly_${k}`,
  v: monthValues[i],
  segment: "demo:scalar",
}));

// Packed: one lambda cel that calls columnFrom on its twelve inputs.
const packedCels: Segment["cels"] = [
  {
    key: "salesColumn",
    segment: "demo:packed",
    schema: COLUMN_SCHEMA_KEY,
    tag: "buffer",
    l: "demo:packMonths",
    inputMap: Object.fromEntries(
      monthKeys.map((k) => [k, `monthly_${k}`]),
    ),
  },
  {
    key: "salesTotal",
    segment: "demo:packed",
    l: COLUMN_SUM_KEY,
    inputMap: { col: "salesColumn" },
  },
];

const userFns = new Map<string, Fn>();
userFns.set("demo:packMonths", (inputs: Record<string, number>): Column => {
  // Object.entries order matches inputMap declaration order; we build
  // a fresh array each fire, then hand it to columnFrom which copies
  // into a freshly allocated typed array and stamps gen: 0.
  const ordered = monthKeys.map((k) => inputs[k]!);
  return columnFrom(ordered, "f64");
});

// ── Hydrate everything together ────────────────────────────────────────────

hydrate(state, [{
  key: "demo",
  cels: [...scalarCels, ...packedCels],
}], [userFns]);

await runCycle(state);

// ── Read the packed values + the sum ───────────────────────────────────────

const salesCol = get(state, "salesColumn") as Column;
const total    = get(state, "salesTotal")  as number;

console.log("─── packed Column ───");
console.log({
  dtype:  salesCol.dtype,
  length: salesCol.length,
  gen:    salesCol.gen,
  data:   Array.from(salesCol.data),
});
console.log(`columnSum -> ${total}`);

// ── Build a 3-column Table from three packed columns ───────────────────────
//
// Same pattern: a lambda packs three independent columns into a single
// Table envelope. tableFrom validates that all three have length 12
// (it'd throw if they didn't — silent shape bugs are the worst kind).

const unitsValues   = monthValues.map((v) => Math.round(v / 5));
const returnsValues = monthValues.map((v) => Math.round(v / 50));

hydrate(state, [{
  key: "demo:table",
  cels: [
    {
      key: "salesTable",
      segment: "demo:packed",
      schema: TABLE_SCHEMA_KEY,
      tag: "buffer",
      l: "demo:buildSalesTable",
    },
  ],
}], [new Map<string, Fn>([
  ["demo:buildSalesTable", (): Table => tableFrom({
    sales:   monthValues,
    units:   unitsValues,
    returns: returnsValues,
  }, "f64")],
])]);

await runCycle(state);
const salesTable = get(state, "salesTable") as Table;

console.log("\n─── packed Table (sales / units / returns × 12 rows) ───");
console.log({
  length:  salesTable.length,
  gen:     salesTable.gen,
  columns: Object.fromEntries(
    Object.entries(salesTable.columns).map(([k, c]) =>
      [k, { dtype: c.dtype, length: c.length, gen: c.gen, data: Array.from(c.data) }],
    ),
  ),
});

// ── Memory comparison ─────────────────────────────────────────────────────
//
// JSON.stringify length is a *very* rough proxy for retained bytes.
// Useful for relative comparison (scalar vs packed of the same data),
// useless for absolute claims. The real measurement comes from the
// schema-level byteLength estimator the perf-tracking pass uses; we
// print both numbers here for context.

import {
  columnByteLength, tableByteLength,
} from "../../../segments/plastron-collections/src/schemas.js";

const scalarJsonBytes = monthKeys
  .map((k, i) => JSON.stringify({ key: `monthly_${k}`, v: monthValues[i] }))
  .reduce((s, t) => s + t.length, 0);

const packedJsonBytes = JSON.stringify({
  key: "salesColumn",
  v: { dtype: salesCol.dtype, length: salesCol.length, gen: salesCol.gen, data: Array.from(salesCol.data) },
}).length;

const packedSchemaBytes = columnByteLength(salesCol);
const tableSchemaBytes  = tableByteLength(salesTable);

console.log("\n─── memory comparison (rough) ───");
console.log(`  scalar JSON proxy (12 cels):  ${scalarJsonBytes} chars`);
console.log(`  packed JSON proxy (1 cel):    ${packedJsonBytes} chars`);
console.log(`  packed Column byteLength():   ${packedSchemaBytes} bytes (typed-array exact + envelope overhead)`);
console.log(`  packed Table  byteLength():   ${tableSchemaBytes} bytes`);

console.log("\n[collections-demo] done.");
