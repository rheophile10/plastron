import type {
  DehydratedCel, Fn, LambdaKey, Segment, State,
} from "../../../plastron/src/types/index.js";
import { el, type VNode } from "../../../segments/plastron-dom/src/index.js";

// ========================================================================
// Sheet segment.
//
// One plastron cel per visible spreadsheet cell, keyed by its address
// ("A1", "B7", …). Plain values live as `{ key, v }`; formulas live as
// `{ key, f }` and the kernel auto-compiles them via the host-registered
// formula at fns["f"] (we plug the Excel-infix one in main.ts).
//
// Control cels:
//   __sheet:selected     — anchor / active cell address. Drives the
//                          name box and formula bar focus.
//   __sheet:selectionEnd — extent of a multi-cell selection. When ""
//                          or === selected, only one cell is selected.
//                          Otherwise the range is the rectangle from
//                          selected to selectionEnd (corners inclusive).
//   __sheet:editing      — address being edited (input shown), or "".
//   __sheet:editSeed     — initial text for the cell editor. Empty
//                          when entering edit mode via double-click
//                          (the input falls back to the cell's
//                          current content); set to a single keystroke
//                          when entering edit mode by typing on a
//                          selected cell (Excel "replace" behavior).
//   __sheet:sources      — { addr → formula source } so the formula
//                          bar can show "=…" without snooping cel
//                          internals.
//   __sheet:copyMark     — { start, end } | null. The "marching ants"
//                          rectangle drawn after a copy. Cleared on
//                          paste or Escape; survives selection
//                          changes so the user can navigate before
//                          pasting (Excel behavior).
//
// Selection lifecycle:
//   mousedown on cell  → set selected = end = addr (or, if shift held,
//                        keep selected and just move end). Set the
//                        in-flight `dragging` flag in module-scope.
//   mouseenter on cell → if dragging, set end = addr.
//   mouseup (document) → clear dragging.
//
// Edit lifecycle:
//   dblclick(addr)             → set editing = addr (renders <input>).
//   commit(addr, source)       → re-hydrate the cel:
//                                  "=…"          → { key, f: source[1:] }
//                                  parses-as-num → { key, v: Number(source) }
//                                  else string   → { key, v: source }
//                                clear editing.
//   Escape during edit         → just clear editing (no commit).
//
// Clipboard (handled in main.ts; helpers exported below):
//   copy  → emit TSV of the selected rectangle (values, not formulas).
//   paste → parse TSV at the active cell. "=foo" entries become
//           formulas; numeric strings become numbers; everything else
//           stays as strings.
// ========================================================================

export const SHEET_SEGMENT = "sheet" as const;

export const COLS = 8;
export const ROWS = 12;

export const colLetter = (c: number): string => String.fromCharCode(65 + c);
export const addressOf = (col: number, row: number): string => `${colLetter(col)}${row + 1}`;

const ADDR_RE = /^([A-Z]+)(\d+)$/;
export const parseAddress = (addr: string): { col: number; row: number } | null => {
  const m = ADDR_RE.exec(addr);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: parseInt(m[2]!, 10) - 1 };
};

export const allAddresses = (): string[] => {
  const out: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) out.push(addressOf(c, r));
  }
  return out;
};

interface Rect { c0: number; r0: number; c1: number; r1: number }

const rectFor = (start: string, end: string): Rect | null => {
  const a = parseAddress(start);
  const b = parseAddress(end || start);
  if (!a || !b) return null;
  return {
    c0: Math.min(a.col, b.col),
    r0: Math.min(a.row, b.row),
    c1: Math.max(a.col, b.col),
    r1: Math.max(a.row, b.row),
  };
};


// Pre-filled sheet — values + formulas to make the demo immediately
// instructive on first load.
const SEED: Record<string, { v?: unknown; f?: string }> = {
  A1: { v: "Item" },        B1: { v: "Qty" },   C1: { v: "Price" }, D1: { v: "Total" },
  A2: { v: "Bone, ox" },    B2: { v: 12 },      C2: { v: 4 },       D2: { f: "=B2*C2" },
  A3: { v: "Plastron" },    B3: { v: 3 },       C3: { v: 17 },      D3: { f: "=B3*C3" },
  A4: { v: "Charcoal" },    B4: { v: 30 },      C4: { v: 0.5 },     D4: { f: "=B4*C4" },
  A5: { v: "Bronze pin" },  B5: { v: 8 },       C5: { v: 2.25 },    D5: { f: "=B5*C5" },
  A7: { v: "Subtotal" },                                              D7: { f: "=D2+D3+D4+D5" },
  A8: { v: "Tax (10%)" },                                             D8: { f: "=D7*0.1" },
  A9: { v: "Grand total" },                                           D9: { f: "=D7+D8" },
};

// ─── render ───────────────────────────────────────────────────────────

const renderSheet: Fn = (inputs: Record<string, unknown>): VNode => {
  const selected     = (inputs["__sheet:selected"]     as string) ?? "";
  const selectionEnd = (inputs["__sheet:selectionEnd"] as string) ?? "";
  const editing      = (inputs["__sheet:editing"]      as string) ?? "";
  const editSeed     = (inputs["__sheet:editSeed"]     as string) ?? "";
  const sources      = (inputs["__sheet:sources"]      as Record<string, string>) ?? {};
  const copyMark     = inputs["__sheet:copyMark"] as { start: string; end: string } | null;

  const rect = selected ? rectFor(selected, selectionEnd || selected) : null;
  const inSelection = (col: number, row: number): boolean =>
    rect !== null && col >= rect.c0 && col <= rect.c1 && row >= rect.r0 && row <= rect.r1;

  const formulaBarText = selected
    ? (sources[selected] !== undefined
        ? `=${sources[selected]}`
        : displayValue(inputs[selected]))
    : "";

  const nameBoxText = !selected
    ? "—"
    : selectionEnd && selectionEnd !== selected
      ? `${selected}:${selectionEnd}`
      : selected;

  const headerCells: VNode[] = [el("th", { class: "corner" }, "")];
  for (let c = 0; c < COLS; c++) {
    headerCells.push(el("th", { class: "col-header" }, colLetter(c)));
  }

  const bodyRows: VNode[] = [];
  for (let r = 0; r < ROWS; r++) {
    const cells: VNode[] = [el("th", { class: "row-header" }, String(r + 1))];
    for (let c = 0; c < COLS; c++) {
      const addr = addressOf(c, r);
      const isAnchor   = selected === addr;
      const isInRange  = inSelection(c, r);
      const isEditing  = editing === addr;
      const value      = inputs[addr];
      const hasFormula = sources[addr] !== undefined;

      const classes = [
        "cell",
        isAnchor ? "anchor" : "",
        isInRange && !isAnchor ? "range" : "",
        isEditing ? "editing" : "",
        hasFormula ? "formula" : "",
        typeof value === "number" ? "numeric" : "",
      ].filter(Boolean).join(" ");

      let inner: VNode | string;
      if (isEditing) {
        // editSeed wins if non-empty (type-to-edit replaces content);
        // otherwise fall back to the cell's current content (double-
        // click preserves it for editing).
        const seed = editSeed !== ""
          ? editSeed
          : (hasFormula ? `=${sources[addr]}` : displayValue(value));
        inner = el("input", {
          class: "cell-input",
          type: "text",
          value: seed,
          onKeyDown: { dispatch: "sheet:editKeyDown", payload: addr },
          onBlur:    { dispatch: "sheet:editBlur",    payload: addr },
        });
      } else {
        inner = displayValue(value);
      }

      cells.push(el("td", {
        class: classes,
        onMouseDown:  { dispatch: "sheet:mouseDown",  payload: addr },
        onMouseEnter: { dispatch: "sheet:mouseEnter", payload: addr },
        onDblClick:   { dispatch: "sheet:edit",       payload: addr },
      }, inner as string));
    }
    bodyRows.push(el("tr", null, ...cells));
  }

  // The marching-ants overlay's position is set imperatively in
  // main.ts (it measures actual cell rects so it stays accurate even
  // if the column widths drift from the CSS pixel values). We just
  // emit the element with `data-rect` so the helper knows which cells
  // to measure.
  const gridChildren: VNode[] = [
    el("table", { class: "grid" },
      el("thead", null, el("tr", null, ...headerCells)),
      el("tbody", null, ...bodyRows),
    ),
  ];
  if (copyMark) {
    gridChildren.push(el("div", {
      class: "copy-marquee",
      "data-start": copyMark.start,
      "data-end":   copyMark.end,
    }));
  }

  return el("div", { class: "sheet" },
    el("div", { class: "toolbar" },
      el("span", { class: "name-box" }, nameBoxText),
      el("input", {
        class: "formula-bar",
        type: "text",
        value: formulaBarText,
        // Disable the bar when no cell is selected — keeps the empty
        // anchor case from accepting random typing.
        disabled: !selected,
        onFocus:   { dispatch: "sheet:formulaBarFocus" },
        onKeyDown: { dispatch: "sheet:formulaBarKeyDown" },
        onBlur:    { dispatch: "sheet:formulaBarBlur" },
      }),
    ),
    el("div", { class: "grid-wrapper" }, ...gridChildren),
  );
};

const displayValue = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number") {
    return Number.isFinite(v)
      ? (Number.isInteger(v) ? String(v) : v.toFixed(2))
      : "—";
  }
  return String(v);
};

// ─── selection: closure-shared drag flag ─────────────────────────────
//
// Module-level on purpose: the in-progress drag state isn't graph-resident
// because it's short-lived UI bookkeeping, not data. Clearing it on a
// document-level mouseup is wired up in main.ts via stopDragging().

let dragging = false;

export const stopDragging = (): void => { dragging = false; };

const mouseDown: Fn = async (...args: unknown[]) => {
  const [state, payload, event] = args as [State, string, MouseEvent | undefined];
  const shift = event?.shiftKey ?? false;
  dragging = true;

  if (shift) {
    // Extend the existing selection to this cell; keep the anchor.
    await (state.fns.get("set") as Fn)(state, "__sheet:selectionEnd", payload);
  } else {
    // Fresh selection — anchor and end collapse to this cell.
    await (state.fns.get("batch") as Fn)(state, [
      ["__sheet:selected",     payload],
      ["__sheet:selectionEnd", payload],
    ]);
  }
};

const mouseEnter: Fn = async (...args: unknown[]) => {
  if (!dragging) return;
  const [state, payload] = args as [State, string];
  const cur = state.cels.get("__sheet:selectionEnd")?.v;
  if (cur === payload) return;
  await (state.fns.get("set") as Fn)(state, "__sheet:selectionEnd", payload);
};

// ─── edit / commit ───────────────────────────────────────────────────

const edit: Fn = async (...args: unknown[]) => {
  const [state, payload] = args as [State, string];
  await (state.fns.get("batch") as Fn)(state, [
    ["__sheet:selected",     payload],
    ["__sheet:selectionEnd", payload],
    ["__sheet:editing",      payload],
    ["__sheet:editSeed",     ""],
  ]);
};

const cancelEdit = async (state: State): Promise<void> => {
  await (state.fns.get("batch") as Fn)(state, [
    ["__sheet:editing",  ""],
    ["__sheet:editSeed", ""],
  ]);
};

/** Enter edit mode on the currently selected cell, seeded with the
 *  given character (Excel-style: typing on a selected cell replaces
 *  its content). Called from main.ts's document keydown listener. */
export const typeIntoSelected: Fn = async (...args: unknown[]) => {
  const [state, payload] = args as [State, string];
  const selected = (state.cels.get("__sheet:selected")?.v as string) ?? "";
  if (!selected) return;
  await (state.fns.get("batch") as Fn)(state, [
    ["__sheet:editing",  selected],
    ["__sheet:editSeed", payload],
  ]);
};

/** Shift the selection by (dc, dr), clamped to the grid. Both anchor
 *  and extent collapse to the new cell — multi-cell selection
 *  collapses on navigation. Called from main.ts on Enter / Tab /
 *  arrow keys, and from editKeyDown after a commit. */
export const moveSelection: Fn = async (...args: unknown[]) => {
  const [state, payload] = args as [State, { dc?: number; dr?: number }];
  const dc = payload?.dc ?? 0;
  const dr = payload?.dr ?? 0;
  const cur = (state.cels.get("__sheet:selected")?.v as string) ?? "";
  if (!cur) return;
  const pos = parseAddress(cur);
  if (!pos) return;
  const newCol = Math.max(0, Math.min(COLS - 1, pos.col + dc));
  const newRow = Math.max(0, Math.min(ROWS - 1, pos.row + dr));
  const newAddr = addressOf(newCol, newRow);
  if (newAddr === cur) return;
  await (state.fns.get("batch") as Fn)(state, [
    ["__sheet:selected",     newAddr],
    ["__sheet:selectionEnd", newAddr],
  ]);
};

const commitFromInput = async (state: State, addr: string, raw: string): Promise<void> => {
  const trimmed = raw.trim();
  const hydrate = state.fns.get("hydrate") as Fn;
  const setFn = state.fns.get("set") as Fn;

  const sources = (state.cels.get("__sheet:sources")?.v as Record<string, string>) ?? {};
  const nextSources: Record<string, string> = { ...sources };

  const dc = parseInputAsCel(addr, trimmed, nextSources);

  hydrate(state, [{ key: SHEET_SEGMENT, cels: [dc] }], []);
  await (state.fns.get("runCycle") as Fn)(state);
  await setFn(state, "__sheet:sources", nextSources);
  await (state.fns.get("batch") as Fn)(state, [
    ["__sheet:editing",  ""],
    ["__sheet:editSeed", ""],
  ]);
};

// Build a dehydrated cel from raw user-input text. Mutates `sources`
// (set or delete) as a side effect — caller passes a fresh-cloned copy.
const parseInputAsCel = (
  addr: string,
  trimmed: string,
  sources: Record<string, string>,
): DehydratedCel => {
  if (trimmed === "") {
    delete sources[addr];
    return { key: addr, v: "", segment: SHEET_SEGMENT };
  }
  if (trimmed.startsWith("=")) {
    const src = trimmed.slice(1).trim();
    sources[addr] = src;
    return { key: addr, f: src, segment: SHEET_SEGMENT };
  }
  const num = Number(trimmed);
  delete sources[addr];
  if (Number.isFinite(num) && trimmed !== "") {
    return { key: addr, v: num, segment: SHEET_SEGMENT };
  }
  return { key: addr, v: trimmed, segment: SHEET_SEGMENT };
};

const editKeyDown: Fn = async (...args: unknown[]) => {
  const [state, payload, event] = args as [State, string, KeyboardEvent];
  const target = event?.target as HTMLInputElement | null;
  if (!target) return;
  if (event.key === "Enter") {
    event.preventDefault?.();
    await commitFromInput(state, payload, target.value);
    // Excel: Enter commits and advances down; shift+Enter goes up.
    await moveSelection(state, event.shiftKey ? { dr: -1 } : { dr: 1 });
  } else if (event.key === "Tab") {
    event.preventDefault?.();
    await commitFromInput(state, payload, target.value);
    // Excel: Tab commits and advances right; shift+Tab goes left.
    await moveSelection(state, event.shiftKey ? { dc: -1 } : { dc: 1 });
  } else if (event.key === "Escape") {
    event.preventDefault?.();
    await cancelEdit(state);
  }
};

const editBlur: Fn = async (...args: unknown[]) => {
  const [state, payload, event] = args as [State, string, FocusEvent];
  const target = event?.target as HTMLInputElement | null;
  if (!target) return;
  await commitFromInput(state, payload, target.value);
};

// ─── formula bar ─────────────────────────────────────────────────────
//
// Formula bar state is closure-tracked because it's UI-local:
//   formulaBarTarget — which cel the bar is editing. Captured on focus
//                      (not read from __sheet:selected at commit-time)
//                      so a click on a different cell during editing
//                      still commits to the originally-edited cell.
//   cancelFormulaBarBlur — set by Escape so the upcoming blur skips
//                          its commit.

let formulaBarTarget = "";
let cancelFormulaBarBlur = false;

const formulaBarFocus: Fn = (state: State) => {
  formulaBarTarget = (state.cels.get("__sheet:selected")?.v as string) ?? "";
  cancelFormulaBarBlur = false;
};

const formulaBarKeyDown: Fn = async (...args: unknown[]) => {
  const [state, , event] = args as [State, unknown, KeyboardEvent];
  const target = event?.target as HTMLInputElement | null;
  if (!target) return;
  if (event.key === "Enter") {
    event.preventDefault?.();
    if (formulaBarTarget) {
      await commitFromInput(state, formulaBarTarget, target.value);
    }
    cancelFormulaBarBlur = true;
    target.blur();
  } else if (event.key === "Escape") {
    event.preventDefault?.();
    cancelFormulaBarBlur = true;
    target.blur();
  }
};

const formulaBarBlur: Fn = async (...args: unknown[]) => {
  const [state, , event] = args as [State, unknown, FocusEvent];
  const target = event?.target as HTMLInputElement | null;
  if (cancelFormulaBarBlur) {
    cancelFormulaBarBlur = false;
    formulaBarTarget = "";
    return;
  }
  if (!target || !formulaBarTarget) {
    formulaBarTarget = "";
    return;
  }
  const captured = formulaBarTarget;
  formulaBarTarget = "";
  await commitFromInput(state, captured, target.value);
};

// ─── clipboard ───────────────────────────────────────────────────────
//
// Both helpers are exported and called from main.ts's document-level
// copy/paste listeners. Document level because copy/paste fire on the
// document when no input is focused, and we want to ignore them when
// a cell IS being edited (the input owns its own copy/paste).

const cellClipboardValue = (state: State, addr: string): string => {
  const v = state.cels.get(addr)?.v;
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);
  return String(v);
};

/** Write the active selection to the clipboard event as TSV. Returns
 *  true if anything was written. */
export const copySelectionTo = (state: State, event: ClipboardEvent): boolean => {
  const start = (state.cels.get("__sheet:selected")?.v as string) ?? "";
  const end   = (state.cels.get("__sheet:selectionEnd")?.v as string) ?? "";
  if (!start) return false;
  const rect = rectFor(start, end || start);
  if (!rect) return false;

  const rows: string[] = [];
  for (let r = rect.r0; r <= rect.r1; r++) {
    const cells: string[] = [];
    for (let c = rect.c0; c <= rect.c1; c++) {
      cells.push(cellClipboardValue(state, addressOf(c, r)));
    }
    rows.push(cells.join("\t"));
  }
  const tsv = rows.join("\n");
  event.clipboardData?.setData("text/plain", tsv);
  event.preventDefault();
  // Mark the source rectangle so the renderer can draw a marching-ants
  // overlay. Fire-and-forget — the clipboard writes don't depend on it.
  void (state.fns.get("set") as Fn)(state, "__sheet:copyMark", {
    start, end: end || start,
  });
  return true;
};

/** Read TSV from the clipboard event and write it into the sheet
 *  starting at the active anchor cell. Out-of-grid entries are
 *  silently dropped. Returns true if anything was pasted. */
export const pasteFromClipboard = async (
  state: State,
  event: ClipboardEvent,
): Promise<boolean> => {
  const text = event.clipboardData?.getData("text/plain");
  if (!text) return false;
  const start = (state.cels.get("__sheet:selected")?.v as string) ?? "";
  const startPos = parseAddress(start);
  if (!startPos) return false;

  // Strip a single trailing newline (typical of clipboard exports)
  // before splitting; otherwise we'd paste a bonus empty row at the
  // bottom.
  const cleaned = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  const rows = cleaned.split("\n").map((line) => line.split("\t"));

  const sources = (state.cels.get("__sheet:sources")?.v as Record<string, string>) ?? {};
  const nextSources: Record<string, string> = { ...sources };
  const cels: DehydratedCel[] = [];

  for (let dr = 0; dr < rows.length; dr++) {
    const row = rows[dr]!;
    for (let dc = 0; dc < row.length; dc++) {
      const c = startPos.col + dc;
      const r = startPos.row + dr;
      if (c >= COLS || r >= ROWS) continue;
      const addr = addressOf(c, r);
      cels.push(parseInputAsCel(addr, row[dc]!.trim(), nextSources));
    }
  }
  if (cels.length === 0) return false;

  event.preventDefault();
  const hydrate = state.fns.get("hydrate") as Fn;
  const setFn = state.fns.get("set") as Fn;
  hydrate(state, [{ key: SHEET_SEGMENT, cels }], []);
  await (state.fns.get("runCycle") as Fn)(state);
  await setFn(state, "__sheet:sources", nextSources);

  // Move selection extent to cover the pasted block, anchor stays at
  // the original active cell — Excel-like.
  const lastC = Math.min(COLS - 1, startPos.col + Math.max(...rows.map((r) => r.length)) - 1);
  const lastR = Math.min(ROWS - 1, startPos.row + rows.length - 1);
  if (lastC > startPos.col || lastR > startPos.row) {
    await setFn(state, "__sheet:selectionEnd", addressOf(lastC, lastR));
  }
  // Clear the marching-ants overlay — pasting consumes the copy.
  await setFn(state, "__sheet:copyMark", null);
  return true;
};

/** Clear the marching-ants overlay (Escape, or any other "cancel
 *  copy" trigger). Called from main.ts. */
export const clearCopyMark = async (state: State): Promise<void> => {
  if (state.cels.get("__sheet:copyMark")?.v == null) return;
  await (state.fns.get("set") as Fn)(state, "__sheet:copyMark", null);
};

// ─── segment factory ──────────────────────────────────────────────────

export const buildSheetSegment = (): { segment: Segment; fns: Map<LambdaKey, Fn> } => {
  const cels: DehydratedCel[] = [
    { key: "__sheet:selected",     v: "",                          segment: SHEET_SEGMENT },
    { key: "__sheet:selectionEnd", v: "",                          segment: SHEET_SEGMENT },
    { key: "__sheet:editing",      v: "",                          segment: SHEET_SEGMENT },
    { key: "__sheet:editSeed",     v: "",                          segment: SHEET_SEGMENT },
    { key: "__sheet:sources",      v: collectInitialSources(),     segment: SHEET_SEGMENT },
    { key: "__sheet:copyMark",     v: null,                        segment: SHEET_SEGMENT },
  ];

  for (const addr of allAddresses()) {
    const seed = SEED[addr];
    if (seed?.f !== undefined) {
      cels.push({ key: addr, f: seed.f, segment: SHEET_SEGMENT });
    } else {
      cels.push({ key: addr, v: seed?.v ?? "", segment: SHEET_SEGMENT });
    }
  }

  const inputMap: Record<string, string> = {
    "__sheet:selected":     "__sheet:selected",
    "__sheet:selectionEnd": "__sheet:selectionEnd",
    "__sheet:editing":      "__sheet:editing",
    "__sheet:editSeed":     "__sheet:editSeed",
    "__sheet:sources":      "__sheet:sources",
    "__sheet:copyMark":     "__sheet:copyMark",
  };
  for (const addr of allAddresses()) inputMap[addr] = addr;

  cels.push({
    key: "sheetTree",
    l: "sheet:render",
    inputMap,
    segment: SHEET_SEGMENT,
  });

  const fns = new Map<LambdaKey, Fn>([
    ["sheet:render",            renderSheet],
    ["sheet:mouseDown",         mouseDown],
    ["sheet:mouseEnter",        mouseEnter],
    ["sheet:edit",              edit],
    ["sheet:editKeyDown",       editKeyDown],
    ["sheet:editBlur",          editBlur],
    ["sheet:typeIntoSelected",  typeIntoSelected],
    ["sheet:moveSelection",     moveSelection],
    ["sheet:formulaBarFocus",   formulaBarFocus],
    ["sheet:formulaBarKeyDown", formulaBarKeyDown],
    ["sheet:formulaBarBlur",    formulaBarBlur],
  ]);

  return { segment: { key: SHEET_SEGMENT, cels }, fns };
};

const collectInitialSources = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [addr, seed] of Object.entries(SEED)) {
    if (seed.f !== undefined) {
      out[addr] = seed.f.startsWith("=") ? seed.f.slice(1) : seed.f;
    }
  }
  return out;
};
