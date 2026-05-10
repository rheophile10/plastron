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

// Enable perf-tracking up-front so stats_precompute gets populated by
// every precompute pass. We use this later to print a memory comparison
// across the consolidate/expand cycle.
import {
  CONFIG_PERFORMANCE, STATS_PRECOMPUTE,
  type PerfConfig, type PrecomputeSnapshot,
} from "../../../plastron/src/index.js";
const perfCel = state.cels.get(CONFIG_PERFORMANCE)!;
(perfCel.v as PerfConfig).enabled         = true;
(perfCel.v as PerfConfig).trackPrecompute = true;

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

// ── consolidateInPlace — turn 12 scalar cels into 1 column + 12 refs ─────
//
// The "before" state in this demo: 12 `monthly_*` scalar cels live as
// inputs to `salesColumn` (which packs them into a Column at fire
// time). Each `monthly_*` cel costs the full per-cel kernel overhead
// even though the data is twelve numbers.
//
// After consolidateInPlace, every `monthly_*` cel becomes a ref into
// slot i of a single `monthly_consolidated` Column cel. Reads still
// route through the same key — `get(state, "monthly_jan")` still
// returns 100 — but the storage is one typed-array buffer plus 12
// thin ref envelopes (≈80 bytes each).
//
// Existing downstream wiring is untouched: any lambda whose inputMap
// names "monthly_jan" keeps working unchanged.

import {
  consolidateInPlace, expandRefs,
} from "../../../segments/plastron-collections/src/consolidate.js";

console.log("\n─── consolidateInPlace workflow (12-cel demo case) ───");

// stats_precompute was populated by the precompute pass at hydrate
// (perf-tracking was enabled before hydrate runs). Read it now for
// the BEFORE picture.
const beforeSnap = state.cels.get(STATS_PRECOMPUTE)?.v as PrecomputeSnapshot | undefined;
const beforeCelCount = state.cels.size;
const beforeBytes    = beforeSnap?.totalEstimatedBytes ?? 0;

console.log(`  before: ${beforeCelCount} cels, ~${beforeBytes} estimated bytes`);
console.log(`  before: get(monthly_jan) = ${get(state, "monthly_jan")}`);

await consolidateInPlace(
  state,
  monthKeys.map((k) => `monthly_${k}`),
  "monthly_consolidated",
  "f64",
);

const afterSnap = state.cels.get(STATS_PRECOMPUTE)?.v as PrecomputeSnapshot | undefined;
const afterCelCount = state.cels.size;
const afterBytes    = afterSnap?.totalEstimatedBytes ?? 0;

console.log(`  after:  ${afterCelCount} cels, ~${afterBytes} estimated bytes`);
console.log(`  after:  get(monthly_jan) = ${get(state, "monthly_jan")}  (still 100, resolved through ref)`);
console.log(`  delta:  ${afterBytes - beforeBytes} bytes ` +
            `(at small N the ref-cel envelopes dominate; consolidation pays off above ~30 cels)`);

// Mutate one slot via the ref — the cascade fires every downstream
// of monthly_consolidated, so salesColumn rebuilds and salesTotal
// updates. (Note: salesColumn re-packs from the ref-resolved values
// since its inputMap names `monthly_*` keys — the abstraction holds.)
const setFn = state.fns.get("set") as Fn;
const beforeMar = get(state, "monthly_mar") as number;
await setFn(state, "monthly_mar", 999);
console.log(`  set monthly_mar 100 → 999:`);
console.log(`    get(monthly_mar) = ${get(state, "monthly_mar")}`);
console.log(`    monthly_consolidated.data[2] = ${(get(state, "monthly_consolidated") as Column).data[2]}`);
// Restore so downstream of demo stays consistent.
await setFn(state, "monthly_mar", beforeMar);

// expandRefs: undo the consolidation. The 12 ref cels go back to
// scalar cels holding their resolved values; monthly_consolidated
// is removed.
await expandRefs(state, "monthly_consolidated");
console.log(`  expandRefs:`);
console.log(`    monthly_consolidated removed: ${!state.cels.has("monthly_consolidated")}`);
console.log(`    get(monthly_jan) = ${get(state, "monthly_jan")}  (back to scalar cel)`);

// ── Same workflow at scale — what the accounting really tells us ─────────
//
// Build N=1000 scalar cels, then consolidate them and compare. The ref
// cels each cost a fixed ~80-byte envelope (REF_CEL_BYTES); the column
// cell holds a Float64Array of N numbers (8N bytes data + ~64 envelope).
//
// IMPORTANT — the perf-accountant is asymmetric (read this before
// taking the bare numbers at face value):
//
//   The kernel's perf-accountant (`stats_precompute.totalEstimatedBytes`)
//   currently counts only a cel's VALUE bytes — 8 per number scalar,
//   `byteLength` for typed-array buffers, and a fixed REF_CEL_BYTES=80
//   for ref cels. It does NOT model the per-cel envelope overhead that
//   every cel pays in V8 (hidden-class slots, key/segment string
//   interning, the Cel object header, ~150-200 bytes of empty
//   bookkeeping per scalar cel). So the bare comparison is apples
//   (8 bytes per scalar cel) to oranges (80 bytes per ref cel) and
//   makes consolidation look like a regression even when it isn't.
//
//   Tuning the accountant to credit envelope overhead consistently is
//   a separate follow-up (it has to land carefully — it'll change
//   every existing perf-tracking baseline). Until then, this demo
//   prints both:
//     1. The raw accountant numbers, framed honestly as raw numbers
//        (not as a "reduction"), and
//     2. An "actual heap estimate" that includes envelope overhead so
//        the comparison is apples-to-apples.
//
// Where consolidation actually wins (independent of the byte count):
//   • The cascade. After consolidating, a write to one slot fires ONE
//     ref-aware cascade pass instead of N separate writes. The single
//     column cel is the unit of change-detection (gen counter), not N
//     independent cels.
//   • Memory-wise, consolidation pays off above ~30 cels for f64. Below
//     that, the ref envelopes (80 bytes each) outweigh the saved scalar
//     value cost even after envelope overhead is credited.

console.log("\n─── consolidateInPlace at scale (1000 cels) ───");

const scaleState = createInitialState();
installCollections(scaleState);
const scalePerf = scaleState.cels.get(CONFIG_PERFORMANCE)!;
(scalePerf.v as PerfConfig).enabled         = true;
(scalePerf.v as PerfConfig).trackPrecompute = true;

const scaleHydrate = scaleState.fns.get("hydrate") as Fn;
const N = 1000;
const scaleCels = [];
for (let i = 0; i < N; i++) {
  scaleCels.push({ key: `x_${i}`, v: i, segment: "scale" });
}
scaleHydrate(scaleState, [{ key: "scale", cels: scaleCels }], []);

// Heap-estimate constants (rough V8-on-x64 figures for instrumentation
// purposes — not exact, but apples-to-apples between scalar and ref
// cel shapes):
//   SCALAR_CEL_ENVELOPE = ~200 bytes   { key, v, segment, ... } object
//                                       header + hidden-class slots +
//                                       interned key/segment strings
//   REF_CEL_ENVELOPE    =   80 bytes   matches the kernel's
//                                       refCelByteLength constant
//   SCALAR_VALUE        =    8 bytes   one f64 per scalar cel
//   COLUMN_ENVELOPE     = ~24 bytes    Float64Array header + Column
//                                       wrapper {dtype, length, gen}
//   COLUMN_DATA         =   8N bytes   Float64Array buffer
const SCALAR_CEL_ENVELOPE = 200;
const REF_CEL_ENVELOPE    = 80;
const SCALAR_VALUE_BYTES  = 8;
const COLUMN_ENVELOPE     = 24;

const scaleBeforeSnap = scaleState.cels.get(STATS_PRECOMPUTE)?.v as PrecomputeSnapshot | undefined;
const scaleBeforeBytes = scaleBeforeSnap?.totalEstimatedBytes ?? 0;
const heapBefore = N * (SCALAR_CEL_ENVELOPE + SCALAR_VALUE_BYTES);

console.log(`  before: ${scaleState.cels.size} cels`);
console.log(`    perf-accountant says: ${scaleBeforeBytes} bytes`);
console.log(`    actual heap estimate: ${heapBefore} bytes ` +
            `(${N} cels × ${SCALAR_CEL_ENVELOPE + SCALAR_VALUE_BYTES} bytes per scalar cel including envelope)`);

await consolidateInPlace(
  scaleState,
  Array.from({ length: N }, (_, i) => `x_${i}`),
  "x_consolidated",
  "f64",
);

const scaleAfterSnap = scaleState.cels.get(STATS_PRECOMPUTE)?.v as PrecomputeSnapshot | undefined;
const scaleAfterBytes = scaleAfterSnap?.totalEstimatedBytes ?? 0;
const columnDataBytes = N * SCALAR_VALUE_BYTES;
const heapAfter = COLUMN_ENVELOPE + columnDataBytes + N * REF_CEL_ENVELOPE;

console.log(`  after:  ${scaleState.cels.size} cels`);
console.log(`    perf-accountant says: ${scaleAfterBytes} bytes`);
console.log(`    actual heap estimate: ${heapAfter} bytes ` +
            `(1 column ≈ ${COLUMN_ENVELOPE + columnDataBytes} bytes + ${N} refs × ${REF_CEL_ENVELOPE} bytes envelope)`);

// Honest framing: report each metric as a raw before/after pair plus a
// signed delta. No "% reduction" wording on the perf-accountant — it
// would be misleading per the caveat above.
const perfDelta = scaleAfterBytes - scaleBeforeBytes;
const heapDelta = heapAfter - heapBefore;
const heapPctChange = heapBefore > 0
  ? Math.round(100 * (heapBefore - heapAfter) / heapBefore)
  : 0;

console.log(`\n  perf-accountant delta: ${perfDelta >= 0 ? "+" : ""}${perfDelta} bytes ` +
            `(scalar baseline = ${scaleBeforeBytes}; consolidated = ${scaleAfterBytes}; ` +
            `goes UP because the accountant doesn't model the envelope overhead the ` +
            `scalar cels already pay — see caveat above)`);
console.log(`  actual heap delta:     ${heapDelta >= 0 ? "+" : ""}${heapDelta} bytes ` +
            `(scalar baseline ≈ ${heapBefore}; consolidated ≈ ${heapAfter}; ` +
            `${heapPctChange >= 0 ? heapPctChange : -heapPctChange}% ` +
            `${heapPctChange >= 0 ? "REDUCTION" : "INCREASE"} once envelope overhead is included)`);
const scaleGet = scaleState.fns.get("get") as Fn;
console.log(`  spot check: get(x_500) = ${scaleGet(scaleState, "x_500")}  (resolves through ref)`);

console.log("\n[collections-demo] done.");
