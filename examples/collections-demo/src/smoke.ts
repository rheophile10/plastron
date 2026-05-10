// ============================================================================
// smoke — verify plastron-collections acceptance criteria from
// notes/tasks/task-consolidation-helpers.md. Each `check` prints
// pass/fail; non-zero exit on any fail.
// ============================================================================

import type { Fn, State } from "../../../plastron/src/index.js";
import { createInitialState } from "../../../plastron/src/index.js";
import {
  BUFFER_TAG_KEY,
  COLUMN_SCHEMA_KEY,
  COLUMN_SUM_KEY, COLUMN_ZIP_KEY,
  DOT_KEY, MATMUL_KEY, MATRIX_SCHEMA_KEY,
  PLASTRON_COLLECTIONS_SEGMENT,
  TABLE_SCHEMA_KEY, TRANSPOSE_KEY,
  bufferTag, columnFrom, columnIsChanged,
  installCollections, matIndex, matrixFrom, slice, tableFrom,
  tableProject,
  type Column, type Table,
} from "../../../segments/plastron-collections/src/index.js";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  if (ok) { pass++; console.log(`  PASS: ${label}`); }
  else    { fail++; console.log(`  FAIL: ${label}`, detail ?? ""); }
};

// ── 1. Builders produce well-formed envelopes ────────────────────────────

const c1 = columnFrom([1, 2, 3, 4], "i32");
check("columnFrom: dtype + length + gen", c1.dtype === "i32" && c1.length === 4 && c1.gen === 0);
check("columnFrom: data is Int32Array", c1.data instanceof Int32Array);

const m1 = matrixFrom([[1, 2, 3], [4, 5, 6]]);
check("matrixFrom: shape", m1.shape[0] === 2 && m1.shape[1] === 3);
check("matrixFrom: data length matches product(shape)", m1.data.length === 6);

const t1 = tableFrom({ a: [1, 2, 3], b: [4, 5, 6] });
check("tableFrom: length cross-check passes", t1.length === 3 && Object.keys(t1.columns).length === 2);

let threw = false;
try { tableFrom({ a: [1, 2, 3], b: [4, 5] }); } catch { threw = true; }
check("tableFrom: rejects mismatched lengths", threw);

threw = false;
try { matrixFrom([[1, 2], [3]]); } catch { threw = true; }
check("matrixFrom: rejects ragged input", threw);

// ── 2. View helpers ──────────────────────────────────────────────────────

check("index: O(1) read", c1.data && (c1.data[2] as number) === 3);
const sliced = slice(c1, 1, 3);
check("slice: returns shared-buffer view", sliced.length === 2 && (sliced.data as Int32Array).buffer === (c1.data as Int32Array).buffer);
check("matIndex: row-major flatten", matIndex(m1, 1, 1) === 5);

// ── 3. isChanged: gen-counter ────────────────────────────────────────────

const colA = columnFrom([1, 2, 3]);
const colB = columnFrom([1, 2, 3]); // same values, different envelope
const colC: Column = { ...colA }; // same gen as colA but new envelope (ref !=)
const colD: Column = { ...colA, gen: colA.gen + 1 };

check("isChanged: ref-equal → false", columnIsChanged(colA, colA) === false);
check("isChanged: same gen, different env → false", columnIsChanged(colA, colC) === false);
check("isChanged: gen bump → true", columnIsChanged(colA, colD) === true);
check("isChanged: different envelopes (independent gen counters but both 0) → false",
  columnIsChanged(colA, colB) === false);
check("isChanged: prev null, next set → true", columnIsChanged(null, colA) === true);

// ── 4. Tag handler: serialize round-trips ────────────────────────────────

const m2 = matrixFrom([[1.5, 2.5], [3.5, 4.5]]);
const ser = bufferTag.serialize!(m2);
const json = JSON.stringify(ser);
const parsed = JSON.parse(json) as { data: number[]; shape: number[]; dtype: string };
check("bufferTag.serialize: matrix → JSON-roundtrippable", Array.isArray(parsed.data) && parsed.data.length === 4);
check("bufferTag.serialize: matrix data preserved", parsed.data[0] === 1.5 && parsed.data[3] === 4.5);
check("bufferTag.serialize: matrix shape preserved", parsed.shape[0] === 2 && parsed.shape[1] === 2);

const cSer = bufferTag.serialize!(c1);
const cParsed = JSON.parse(JSON.stringify(cSer)) as { data: number[]; dtype: string };
check("bufferTag.serialize: column data preserved", cParsed.data.length === 4 && cParsed.data[0] === 1);

const tSer = bufferTag.serialize!(t1);
const tParsed = JSON.parse(JSON.stringify(tSer)) as { columns: Record<string, { data: number[] }> };
check("bufferTag.serialize: table columns preserved",
  tParsed.columns.a!.data[0] === 1 && tParsed.columns.b!.data[2] === 6);

// release is a no-op but must be callable.
let releaseOk = true;
try { bufferTag.release!(c1); } catch { releaseOk = false; }
check("bufferTag.release: callable (no-op)", releaseOk);

// byteLength dispatches
check("bufferTag.byteLength: column", bufferTag.byteLength!(c1) >= c1.data.byteLength);
check("bufferTag.byteLength: matrix", bufferTag.byteLength!(m1) >= m1.data.byteLength);
check("bufferTag.byteLength: table", bufferTag.byteLength!(t1) > 0);

// ── 5. installCollections: idempotent + locked-respecting ────────────────

const state: State = createInitialState();
installCollections(state);

check("installCollections: schemas registered",
  state.schemas.has(COLUMN_SCHEMA_KEY)
  && state.schemas.has(TABLE_SCHEMA_KEY)
  && state.schemas.has(MATRIX_SCHEMA_KEY));

check("installCollections: schemaMetadata wired",
  !!state.schemaMetadata.get(COLUMN_SCHEMA_KEY)?.isChanged
  && !!state.schemaMetadata.get(COLUMN_SCHEMA_KEY)?.byteLength);

check("installCollections: tag handler registered",
  state.tagRegistry.get(BUFFER_TAG_KEY) === bufferTag);

check("installCollections: operator fns registered",
  state.fns.has(COLUMN_SUM_KEY)
  && state.fns.has(COLUMN_ZIP_KEY)
  && state.fns.has(DOT_KEY)
  && state.fns.has(MATMUL_KEY)
  && state.fns.has(TRANSPOSE_KEY));

check("installCollections: manifest recorded",
  state.segments.get(PLASTRON_COLLECTIONS_SEGMENT)?.version === "0.0.1");

const beforeFnSize = state.fns.size;
const beforeSchemaSize = state.schemas.size;
installCollections(state);
check("installCollections: idempotent (no fn growth)", state.fns.size === beforeFnSize);
check("installCollections: idempotent (no schema growth)", state.schemas.size === beforeSchemaSize);

// Locked entry survives a re-install. Replace columnSum with a sentinel
// fn marked locked, then re-call installCollections.
const sentinel: Fn = () => 999;
state.fns.set(COLUMN_SUM_KEY, sentinel);
state.fnMetadata.set(COLUMN_SUM_KEY, { key: COLUMN_SUM_KEY, locked: true });
installCollections(state);
check("installCollections: locked entry preserved", state.fns.get(COLUMN_SUM_KEY) === sentinel);

// ── 6. Operator behavior in a real cascade — gen bump triggers re-fire ──

const state2 = createInitialState();
installCollections(state2);

const hydrate2  = state2.fns.get("hydrate")  as Fn;
const runCycle2 = state2.fns.get("runCycle") as Fn;
const set2      = state2.fns.get("set")      as Fn;

let downstreamFires = 0;
hydrate2(state2, [{
  key: "demo",
  cels: [
    { key: "raw", v: [1, 2, 3], segment: "demo" },
    {
      key: "col", segment: "demo",
      schema: COLUMN_SCHEMA_KEY, tag: "buffer",
      l: "demo:pack", inputMap: { xs: "raw" },
    },
    {
      key: "watcher", segment: "demo",
      l: "demo:watch", inputMap: { col: "col" },
    },
  ],
}], [new Map<string, Fn>([
  ["demo:pack", ({ xs }: { xs: number[] }) => columnFrom(xs)],
  ["demo:watch", ({ col }: { col: Column }) => {
    downstreamFires++;
    return col.length;
  }],
])]);

await runCycle2(state2);
const after1 = downstreamFires;
check("cascade: watcher fired once after first cycle", after1 === 1);

// `set` uses suppression mode. col rebuilds → fresh envelope at gen 0.
// columnIsChanged(prev, next) sees gen 0 vs gen 0 → returns false →
// watcher does NOT re-fire downstream of col.
//
// (`runCycle` runs in full mode and would re-fire everything; the
// suppression contract only applies to set/batch/touch/consume paths.)
await set2(state2, "raw", [10, 20, 30, 40]);
check("cascade: gen=0 → gen=0 (set path, fresh envelope) suppresses downstream",
  downstreamFires === after1);

// Now do it the right way: produce a new envelope with a bumped gen.
state2.fns.set("demo:pack", ({ xs }: { xs: number[] }) => {
  const c = columnFrom(xs);
  c.gen = (Math.random() * 1e9) | 0; // any positive bump
  return c;
});
await set2(state2, "raw", [100, 200, 300]);
check("cascade: gen bump triggers watcher re-fire (set path)", downstreamFires > after1);

// ── 7. tableProject + slice + matIndex behavior ──────────────────────────

const proj = tableProject({ t: t1, names: ["a"] }) as Table;
check("tableProject: only requested columns", Object.keys(proj.columns).length === 1 && "a" in proj.columns);
check("tableProject: column reused (zero-copy)", proj.columns.a === t1.columns.a);

const m3 = matrixFrom([[1, 2], [3, 4], [5, 6]]);
check("matIndex: rank-2", matIndex(m3, 2, 1) === 6);

// ── 8. Final summary ─────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
