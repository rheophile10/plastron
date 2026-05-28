import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, buildSheet } from "../dist/index.js";

// spreadsheet-segment — the `infix` FormulaCel parser + buildSheet grid
// factory + action cels. A cell is a ValueCel (literal) or a FormulaCel
// (parser: infix); A1-style refs resolve to sibling sheet.<addr> keys and
// drive the cascade. See docs/3-test-design/00-ontology/spreadsheet-segment.md.

const bootSheet = async (opts) => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const seg = buildSheet(opts);
  await hydrate(state, [seg], [seg]);
  await precomputeOptional(state);
  return state;
};
const v = (state, key) => state.cels.get(key)?.v;

// ── worked example: B1 = =A1*2 updates when A1 changes ──────────────────────

test("5×5 sheet: B1 = =A1*2 computes and updates when A1 is set", async () => {
  const state = await bootSheet({ rows: 5, cols: 5, cells: { A1: "10", B1: "=A1*2" } });
  // A1 is a ValueCel; B1 is a FormulaCel whose dep auto-wired to sheet.A1.
  assert.equal(state.cels.get("sheet.A1").celType, "ValueCel");
  assert.equal(state.cels.get("sheet.B1").celType, "FormulaCel");
  assert.equal(state.cels.get("sheet.B1").metadata.inputMap["sheet.A1"], "sheet.A1", "A1 ref auto-wired");

  const runCycle = resolveFn(state, "runCycle");
  await runCycle(state);
  assert.equal(v(state, "sheet.B1"), 20, "=A1*2 with A1=10");

  const set = resolveFn(state, "set");
  await set(state, "sheet.A1", 5);
  assert.equal(v(state, "sheet.B1"), 10, "downstream formula recomputed on edit");
});

test("infix functions + ranges: SUM / IF resolve sibling cells", async () => {
  const state = await bootSheet({ rows: 3, cols: 3, cells: {
    A1: "1", A2: "2", A3: "3",
    B1: "=SUM(A1:A3)", B2: "=IF(A1<A2, 100, 200)", B3: "=A1 & \"x\"",
  } });
  const runCycle = resolveFn(state, "runCycle");
  await runCycle(state);
  assert.equal(v(state, "sheet.B1"), 6, "SUM over a range");
  assert.equal(v(state, "sheet.B2"), 100, "IF on a comparison");
  assert.equal(v(state, "sheet.B3"), "1x", "& string concat");
});

// ── cycle trap ──────────────────────────────────────────────────────────────

test("a formula cycle (A1=B1, B1=A1) traps with a CycleError", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const seg = buildSheet({ rows: 2, cols: 2, cells: { A1: "=B1", B1: "=A1" } });
  await assert.rejects(() => hydrate(state, [seg], [seg]), /cycle/i, "precompute rejects on a dependency cycle");
  const errs = v(state, "errors") ?? [];
  assert.ok(errs.some((e) => e?.trap === "CycleError"), "CycleError recorded in the errors log");
});

// ── control cels + actions ──────────────────────────────────────────────────

test("control cels seed and the start-edit / move-selection / cancel-edit actions drive them", async () => {
  const state = await bootSheet({ rows: 4, cols: 4, cells: { A1: "10", B1: "=A1*2" } });
  const runCycle = resolveFn(state, "runCycle");
  await runCycle(state);

  assert.deepEqual(v(state, "sheet.selection"), { row: 0, col: 0 });
  assert.deepEqual(v(state, "sheet.editing"), { editing: false, draft: "" });

  const startEdit = resolveFn(state, "sheet.start-edit");
  await startEdit(state);
  assert.deepEqual(v(state, "sheet.editing"), { editing: true, draft: "10" }, "draft seeded from A1's source");

  const cancel = resolveFn(state, "sheet.cancel-edit");
  await cancel(state);
  assert.deepEqual(v(state, "sheet.editing"), { editing: false, draft: "" });

  const move = resolveFn(state, "sheet.move-selection");
  await move(state, { row: 0, col: 1 });
  assert.deepEqual(v(state, "sheet.selection"), { row: 0, col: 1 }, "moved to B1");
  assert.equal(v(state, "sheet.formula-bar"), "=A1*2", "formula bar mirrors B1's source");

  await move(state, { dc: 99, dr: -5 }); // clamps to grid bounds
  assert.deepEqual(v(state, "sheet.selection"), { row: 0, col: 3 }, "clamped to the 4×4 grid");
});

test("commit-cell writes a formula then a literal, recomputing downstream", async () => {
  const state = await bootSheet({ rows: 3, cols: 3, cells: { A1: "4", B1: "6" } });
  const runCycle = resolveFn(state, "runCycle");
  await runCycle(state);

  const commit = resolveFn(state, "sheet.commit-cell");
  await commit(state, { addr: "C1", input: "=A1+B1" });
  assert.equal(state.cels.get("sheet.C1").celType, "FormulaCel", "committing =… installs a FormulaCel");
  assert.equal(v(state, "sheet.C1"), 10, "C1 = A1+B1");
  assert.deepEqual(v(state, "sheet.editing"), { editing: false, draft: "" }, "editor cleared on commit");

  // A plain value into the existing data cell A1 routes through set.
  await commit(state, { addr: "A1", input: "20" });
  assert.equal(v(state, "sheet.A1"), 20);
  assert.equal(v(state, "sheet.C1"), 26, "downstream formula recomputed after the value edit");
});

// ── performance shape ───────────────────────────────────────────────────────

test("50×50 hydrates < 1s; setting a cell read by 100 formulas fires in ~one frame", async () => {
  const cells = { A1: "1" };
  for (let i = 0; i < 100; i++) {
    const col = i < 50 ? "B" : "C";
    const row = (i % 50) + 1;
    cells[`${col}${row}`] = `=A1+${i}`;
  }

  const t0 = performance.now();
  const state = await bootSheet({ rows: 50, cols: 50, cells });
  const hydrateMs = performance.now() - t0;
  assert.ok(hydrateMs < 1000, `50×50 hydrate should be < 1s (was ${hydrateMs.toFixed(0)}ms)`);

  const runCycle = resolveFn(state, "runCycle");
  await runCycle(state);
  assert.equal(v(state, "sheet.B1"), 1, "=A1+0");
  assert.equal(v(state, "sheet.C50"), 100, "=A1+99");

  const set = resolveFn(state, "set");
  await set(state, "sheet.A1", 2); // warm up the path (JIT, downstream cache)
  // Best-of-3 to take measurement noise out of the one-frame claim.
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const s0 = performance.now();
    await set(state, "sheet.A1", 3 + k);
    best = Math.min(best, performance.now() - s0);
  }
  assert.equal(v(state, "sheet.B1"), 5); // last write set A1=5 → B1 = A1+0 = 5
  assert.ok(best < 16, `setting a cell read by 100 formulas should fire in < 16ms (best ${best.toFixed(2)}ms)`);
});
