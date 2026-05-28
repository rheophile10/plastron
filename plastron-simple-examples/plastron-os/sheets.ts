// ============================================================================
// Sheets v1.1 — per-cell view cels (Option A), shared file toolbar,
// metadata panel for the selected cell.
//
// Each cell at sheet.<addr> has a tiny `sheet.<addr>.view` FormulaCel that
// emits a `<td>` VNode (the kernel's `view-layer vnode-embed` extension lets
// us interpolate a VNode value as a child). On an edit, ONLY that cell's
// view fires + the table re-composes — the diff bails on every other cell's
// ref-stable subtree (raf-channel's keyed/subtree bail-out). Selection
// highlight is applied at table assembly via a clone-with-class so per-cell
// views don't all depend on sel.
//
// First draft: modest grid (6×6 by default), metadata panel is read-only (a
// JSON pre block) — editable metadata + virtualized large grids are v1.2.
// ============================================================================

import { resolveFn, buildSheet } from "../../plastron-simple/dist/index.js";
import { addrFrom, indexToCol, parseRef, cellKey } from "../../plastron-simple/dist/甲骨坑/sheet/address.js";
import { setupFileToolbar } from "./file-toolbar.js";
import { registerDocBinding } from "./doc-binding.js";

// ── per-cell vnode + table composer (registered fns) ────────────────────────

type V = { type: "el" | "text"; tag?: string; key?: string; attrs?: Record<string, unknown>; events?: Record<string, unknown>; children?: V[]; text?: string };

const displayValue = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number") return Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : "—";
  return String(v);
};

/** A `<td>` VNode for a single cell — addr is baked in as a literal so the
 *  click binding doesn't need to re-resolve it at paint time. */
export const cellVnode = (value: unknown, addr: string): V => ({
  type: "el", tag: "td",
  key: addr,
  attrs: { class: "cell", "data-addr": addr },
  events: { click: { f: `(dispatch "sheet.click" "${addr}")` } },
  children: [{ type: "text", text: displayValue(value) }],
});

/** Compose the full `<table>` VNode from the per-cell VNodes (row-major).
 *  The selected cell is rendered as a clone with `.selected` class so the
 *  per-cell views don't have to depend on sel (only the truly-changed cell
 *  refires; the selection highlight is a render-time concern here). */
export const assembleTable = (
  cellViews: V[], dims: { rows: number; cols: number }, sel: { row: number; col: number } | undefined,
): V => {
  const rows = dims?.rows ?? 0, cols = dims?.cols ?? 0;
  const headerCols: V[] = [{ type: "el", tag: "th", attrs: { class: "corner" }, children: [] }];
  for (let c = 0; c < cols; c++) headerCols.push({ type: "el", tag: "th", children: [{ type: "text", text: indexToCol(c) }] });
  const thead: V = { type: "el", tag: "thead", children: [{ type: "el", tag: "tr", children: headerCols }] };

  const bodyRows: V[] = [];
  for (let r = 0; r < rows; r++) {
    const tr: V[] = [{ type: "el", tag: "th", attrs: { class: "rownum" }, children: [{ type: "text", text: String(r + 1) }] }];
    for (let c = 0; c < cols; c++) {
      const base = cellViews[r * cols + c];
      if (!base) continue;
      if (sel && sel.row === r && sel.col === c) {
        const attrs = { ...(base.attrs ?? {}), class: `${(base.attrs?.class as string) ?? "cell"} selected` };
        tr.push({ ...base, attrs });
      } else {
        tr.push(base);
      }
    }
    bodyRows.push({ type: "el", tag: "tr", children: tr });
  }
  return { type: "el", tag: "table", attrs: { class: "sheet" }, children: [thead, { type: "el", tag: "tbody", children: bodyRows }] };
};

/** "A1" of the current selection. */
export const selAddr = (sel: { row: number; col: number } | undefined): string =>
  sel ? addrFrom(sel.col ?? 0, sel.row ?? 0) : "";

// ── dispatch helpers (sheet-side; the file toolbar lives in file-toolbar.ts) ─

const cellSource = (state: any, addr: string): string => {
  const cel = state.cels.get(cellKey(addr));
  if (!cel) return "";
  if (cel.celType === "FormulaCel") return (cel.f as string | undefined) ?? "";
  return cel.v === "" || cel.v == null ? "" : String(cel.v);
};

const clickCell = async (state: any, addr: string): Promise<void> => {
  const ref = parseRef(addr) ?? { row: 0, col: 0 };
  await resolveFn(state, "batch")(state, [
    ["sheet.selection", { row: ref.row, col: ref.col }],
    ["sheet.formula-bar", cellSource(state, addr)],
  ], { flush: "all" });
};

const barInput = async (state: any, _p: unknown, event: any): Promise<void> => {
  await resolveFn(state, "set")(state, "sheet.formula-bar", event?.target?.value ?? "");
};

const commit = async (state: any): Promise<void> => {
  const sel = (resolveFn(state, "get")(state, "sheet.selection") as { row: number; col: number } | undefined) ?? { row: 0, col: 0 };
  const addr = addrFrom(sel.col, sel.row);
  const input = String(resolveFn(state, "get")(state, "sheet.formula-bar") ?? "");
  await resolveFn(state, "sheet.commit-cell")(state, { addr, input });
  await resolveFn(state, "drain")(state, "plastron-dom.paint");
};

// ── the sheet view template ─────────────────────────────────────────────────

const SHEET_TEMPLATE = `
<div class="sheet-app">
  {{(renderFileToolbar doc)}}
  <div class="bar">
    <button class="close" onClick={{(dispatch "os.exit")}}>×</button>
    <span class="cellref">{{(selAddr sel)}}</span>
    <input class="fx" value={{formulaBar}} onInput={{(dispatch "sheet.bar-input")}} />
    <button class="commit" onClick={{(dispatch "sheet.commit")}}>✓</button>
  </div>
  <div class="grid">{{(assembleTable cellViews dims sel)}}</div>
  <div class="meta-panel">
    <h4>{{(selAddr sel)}} — metadata</h4>
    <pre class="meta">{{(currentMeta sel)}}</pre>
  </div>
</div>`;

// ── builder ─────────────────────────────────────────────────────────────────

export const buildSheetsApp = async (
  state: any, opts: { rows?: number; cols?: number; cells?: Record<string, string> } = {},
): Promise<void> => {
  const rows = opts.rows ?? 6;
  const cols = opts.cols ?? 6;
  const reg = resolveFn(state, "registerLambda") as (s: unknown, a: unknown) => Promise<unknown>;
  await reg(state, { key: "cellVnode", fn: cellVnode, kind: "custom" });
  await reg(state, { key: "assembleTable", fn: assembleTable, kind: "custom" });
  await reg(state, { key: "selAddr", fn: selAddr, kind: "custom" });
  await reg(state, { key: "sheet.click", fn: clickCell, kind: "custom" });
  await reg(state, { key: "sheet.bar-input", fn: barInput, kind: "custom" });
  await reg(state, { key: "sheet.commit", fn: commit, kind: "custom" });
  await reg(state, { key: "if", fn: (c: unknown, a: unknown, b: unknown) => (c ? a : b), kind: "custom" });
  await reg(state, { key: "eq", fn: (a: unknown, b: unknown) => a === b, kind: "custom" });

  // currentMeta closes over state so the template can show the selected
  // cel's metadata without dragging state through the formula language.
  await reg(state, {
    key: "currentMeta", kind: "custom",
    fn: (sel: { row?: number; col?: number } | undefined) => {
      if (!sel) return "(no selection)";
      const cel = state.cels.get(cellKey(addrFrom(sel.col ?? 0, sel.row ?? 0)));
      if (!cel) return "(no cell)";
      const view: Record<string, unknown> = { celType: cel.celType, metadata: cel.metadata };
      if (cel.f !== undefined) view.f = cel.f;
      if (cel.celType === "ValueCel") view.v = cel.v;
      return JSON.stringify(view, null, 2);
    },
  });
  await setupFileToolbar(state);

  // grid data + view cel keys (row-major). View keys feed sheet.view's
  // array-ref input; data keys go into the doc-binding registry so File
  // toolbar's new/save/open knows which cels are document content.
  const cellViewKeys: string[] = [];
  const cellDataKeys: string[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const addr = addrFrom(c, r);
    cellViewKeys.push(`sheet.${addr}.view`);
    cellDataKeys.push(cellKey(addr));
  }
  registerDocBinding({ app: "sheets", cels: cellDataKeys, empty: () => "" });

  const seg = buildSheet({ rows, cols, cells: opts.cells ?? {}, segment: "sheets" }) as { name: string; version: string; dependencies: string[]; cels: any[] };

  // per-cell view cels — one FormulaCel per cell emits a <td> VNode
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const addr = addrFrom(c, r);
    seg.cels.push({
      key: `sheet.${addr}.view`, celType: "FormulaCel",
      metadata: { key: `sheet.${addr}.view`, segment: "sheets", parser: "f", inputMap: { value: cellKey(addr) } },
      f: `(cellVnode value "${addr}")`,
    });
  }

  seg.cels.push({
    key: "sheet.mount", celType: "FormulaCel",
    metadata: { key: "sheet.mount", segment: "sheets", parser: "f", inputMap: { active: "os.active" } },
    f: `(if (eq active "sheets") "#app" null)`,
  });
  seg.cels.push({
    key: "sheet.view", celType: "FormulaCel",
    metadata: {
      key: "sheet.view", segment: "sheets", parser: "html-template", schema: "render-spec",
      channel: ["plastron-dom.paint"],
      inputMap: { mount: "sheet.mount", sel: "sheet.selection", formulaBar: "sheet.formula-bar", doc: "os.doc", cellViews: cellViewKeys, dims: "sheet.dims" },
    },
    f: SHEET_TEMPLATE,
  });

  const deps = ["sheet", "app-host", "html-template-parser", "plastron-dom", "segment-store", "user-space-ops"];
  const hydrate = resolveFn(state, "hydrate") as (s: unknown, segs: unknown, m: unknown) => Promise<unknown>;
  await hydrate(state, [{ ...seg, dependencies: deps, role: "application" }], [{ name: "sheets", version: "0.1.0", dependencies: deps, role: "application" }]);
};
