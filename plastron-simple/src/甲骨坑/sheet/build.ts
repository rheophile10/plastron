import type { Cel, DehydratedCel, Fn, State, 甲骨 } from "../../types/index.js";
import { inflateCel, compileCelBody, resolveSchemas } from "../../kernel/lifecycle/index.js";
import { precompute } from "../../kernel/precompute/index.js";
import { resolveFn } from "../../kernel/resolve-fn.js";
import { addrFrom, cellKey } from "./address.js";

// ============================================================================
// Sheet grid factory + action fns. buildSheet generates the data layer — an
// N×M grid of cell cels plus the selection / editing / formula-bar control
// cels — as a segment the host hydrates. The reusable machinery (the `infix`
// parser and the action cels) ships in the boot `sheet` segment.
//
// A cell whose source begins with `=` is a FormulaCel (parser: infix); any
// other cell is a ValueCel holding a literal. This split matters: the kernel's
// `set` writes ValueCels (data entry), formulas recompute through the cascade,
// and a commit that changes a cell between the two re-installs the cel.
// ============================================================================

const isFormulaSource = (s: string): boolean => s.trimStart().startsWith("=");

const literal = (s: string): unknown => {
  if (s === "") return "";
  return Number.isNaN(Number(s)) ? s : Number(s);
};

/** Build the DehydratedCel for an address from its raw source. */
const cellCel = (addr: string, segment: string, source: string): DehydratedCel => {
  const key = cellKey(addr);
  if (isFormulaSource(source)) {
    return { key, celType: "FormulaCel", metadata: { key, segment, parser: "infix" }, f: source };
  }
  return { key, celType: "ValueCel", metadata: { key, segment }, v: literal(source) } as unknown as DehydratedCel;
};

export interface BuildSheetOpts {
  rows: number;
  cols: number;
  /** Initial cell contents by A1 address, e.g. { A1: "10", B1: "=A1*2" }. */
  cells?: Record<string, string>;
  /** Segment name to tag the generated cels with (default "sheet-grid"). */
  segment?: string;
}

/** Build the sheet data segment: an N×M grid + control cels. The cels are
 *  pure data (no _fn), so the host hydrates them directly. */
export const buildSheet = (opts: BuildSheetOpts): 甲骨 & { version: string; dependencies: string[] } => {
  const segment = opts.segment ?? "sheet-grid";
  const cells = opts.cells ?? {};
  const dc: DehydratedCel[] = [];
  for (let r = 0; r < opts.rows; r++) {
    for (let c = 0; c < opts.cols; c++) {
      const addr = addrFrom(c, r);
      dc.push(cellCel(addr, segment, cells[addr] ?? ""));
    }
  }
  // Control cels.
  const ctrl = (key: string, v: unknown): DehydratedCel =>
    ({ key, celType: "ValueCel", metadata: { key, segment }, v } as unknown as DehydratedCel);
  dc.push(ctrl("sheet.selection", { row: 0, col: 0 }));
  dc.push(ctrl("sheet.editing", { editing: false, draft: "" }));
  dc.push(ctrl("sheet.formula-bar", ""));
  dc.push(ctrl("sheet.dims", { rows: opts.rows, cols: opts.cols }));
  dc.push(ctrl("sheet.segment", segment));
  return { name: segment, version: "0.0.1", dependencies: ["sheet"], cels: dc };
};

// ── action fns (bound as the sheet.* action cels) ───────────────────────────

const readV = (state: State, key: string): unknown => state.cels.get(key)?.v;

/** Source string a cell currently holds (formula `f` or stringified value). */
const cellSource = (state: State, addr: string): string => {
  const cel = state.cels.get(cellKey(addr));
  if (!cel) return "";
  if (cel.celType === "FormulaCel") return (cel.f as string | undefined) ?? "";
  return cel.v === "" || cel.v === null || cel.v === undefined ? "" : String(cel.v);
};

const selectedAddr = (state: State): string => {
  const sel = readV(state, "sheet.selection") as { row: number; col: number } | undefined;
  return addrFrom(sel?.col ?? 0, sel?.row ?? 0);
};

/** start-edit — open the editor on the selected (or given) cell, seeding the
 *  draft with the cell's current source. */
export const startEdit: Fn = async (state: State, payload?: { addr?: string }) => {
  const addr = payload?.addr ?? selectedAddr(state);
  const set = resolveFn(state, "set")!;
  await set(state, "sheet.editing", { editing: true, draft: cellSource(state, addr) });
  return state;
};

/** cancel-edit — discard the draft. */
export const cancelEdit: Fn = async (state: State) => {
  const set = resolveFn(state, "set")!;
  await set(state, "sheet.editing", { editing: false, draft: "" });
  return state;
};

/** move-selection — set the selection to an absolute { row, col } or apply a
 *  { dr, dc } delta, clamped to the grid; mirror the cell's source into the
 *  formula bar. Uses batch so selection + formula-bar update together. */
export const moveSelection: Fn = async (
  state: State, payload: { row?: number; col?: number; dr?: number; dc?: number },
) => {
  const dims = (readV(state, "sheet.dims") as { rows: number; cols: number } | undefined) ?? { rows: 1, cols: 1 };
  const cur = (readV(state, "sheet.selection") as { row: number; col: number } | undefined) ?? { row: 0, col: 0 };
  const clamp = (n: number, max: number): number => Math.max(0, Math.min(max - 1, n));
  const row = clamp(payload.row ?? cur.row + (payload.dr ?? 0), dims.rows);
  const col = clamp(payload.col ?? cur.col + (payload.dc ?? 0), dims.cols);
  const batch = resolveFn(state, "batch")!;
  await batch(state, [
    ["sheet.selection", { row, col }],
    ["sheet.formula-bar", cellSource(state, addrFrom(col, row))],
  ]);
  return state;
};

/** commit-cell — write the editing draft (or a given input) into the target
 *  cell. A cell that flips between literal and formula changes celType, which
 *  `set` cannot do, so the cel is re-installed (inflate + compile + precompute)
 *  and the graph recomputed. The simple value-into-ValueCel case still routes
 *  through `set`. */
export const commitCell: Fn = async (
  state: State, payload?: { addr?: string; input?: string },
) => {
  const addr = payload?.addr ?? selectedAddr(state);
  const editing = readV(state, "sheet.editing") as { draft?: string } | undefined;
  const input = payload?.input ?? editing?.draft ?? "";
  const key = cellKey(addr);
  const existing = state.cels.get(key);
  const segment = (readV(state, "sheet.segment") as string | undefined)
    ?? existing?.metadata.segment ?? "sheet-grid";

  const formula = isFormulaSource(input);
  const set = resolveFn(state, "set")!;

  if (!formula && existing && existing.celType === "ValueCel") {
    // Fast path: plain value into an existing data cell — fire downstream.
    await set(state, key, literal(input));
  } else {
    // Re-install the cell at the right kind, recompile, rewire, recompute.
    const live = inflateCel(cellCel(addr, segment, input));
    state.cels.set(key, live as Cel);
    if (live.celType === "FormulaCel") await compileCelBody(live, state);
    resolveSchemas(state);
    precompute(state);
    const runCycle = resolveFn(state, "runCycle")!;
    await runCycle(state);
  }

  await set(state, "sheet.editing", { editing: false, draft: "" });
  return state;
};
