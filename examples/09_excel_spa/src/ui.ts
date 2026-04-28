import type { State } from "../../../plastron/src/state/index.js";
import { replaceCels } from "../../../plastron/src/index.js";
import {
  COLS, ROWS, allKeys, parseRaw, rawText, snapshotCel,
  type CellKey,
} from "./sheet.js";

const $ = <T extends HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

let state: State;
let activeCell: CellKey = "A1";
let editing: { key: CellKey; el: HTMLInputElement } | null = null;
let stepDelay = 180;
let cycleCounter = 0;

// ------------------------------------------------------------------------

export const mountUI = (rt: State) => {
  state = rt;
  buildGrid();
  wireFormulaBar();
  wireKeyboard();
  wireDelayControl();
  wireLogControls();
  refreshAllCells();
  selectCell("A1");
};

// ---------- Grid construction ----------

const cellEl = (key: CellKey): HTMLDivElement | null =>
  document.querySelector(`.cell[data-key="${key}"]`);

const buildGrid = () => {
  const grid = $("#grid");
  grid.appendChild(makeStaticCell("", "header"));
  for (const c of COLS) grid.appendChild(makeStaticCell(c, "header"));
  for (const r of ROWS) {
    grid.appendChild(makeStaticCell(String(r), "row-header"));
    for (const c of COLS) {
      const key = `${c}${r}`;
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.key = key;
      cell.addEventListener("mousedown", (e) => {
        if (editing) finishEdit(true);
        selectCell(key);
        e.preventDefault();
      });
      cell.addEventListener("dblclick", () => beginEdit(key));
      grid.appendChild(cell);
    }
  }
};

const makeStaticCell = (text: string, kind: "header" | "row-header"): HTMLDivElement => {
  const el = document.createElement("div");
  el.className = `cell ${kind}`;
  el.textContent = text;
  return el;
};

// ---------- Selection + editing ----------

const selectCell = (key: CellKey) => {
  if (activeCell) cellEl(activeCell)?.classList.remove("selected");
  activeCell = key;
  cellEl(key)?.classList.add("selected");
  cellEl(key)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  $("#active-cell-label").textContent = key;
  ($("#formula-input") as HTMLInputElement).value = rawText(state, key);
};

const beginEdit = (key: CellKey, seedChar?: string) => {
  if (editing) finishEdit(true);
  selectCell(key);
  const el = cellEl(key);
  if (!el) return;
  const input = document.createElement("input");
  input.className = "cell-input";
  input.value = seedChar ?? rawText(state, key);
  el.textContent = "";
  el.appendChild(input);
  input.focus();
  if (seedChar) input.setSelectionRange(seedChar.length, seedChar.length);
  else input.select();
  editing = { key, el: input };

  input.addEventListener("input", () => {
    ($("#formula-input") as HTMLInputElement).value = input.value;
  });
};

const finishEdit = async (commit: boolean): Promise<void> => {
  if (!editing) return;
  const { key, el } = editing;
  const text = el.value;
  editing = null;
  refreshCellDisplay(key);
  if (commit) await commitAndAnimate(key, text);
};

// ---------- Commit + cascade animation ----------

const commitAndAnimate = async (key: CellKey, text: string): Promise<void> => {
  const before = snapshotCel(state, key);
  const beforeText = rawText(state, key);
  if (text === beforeText) return;

  try {
    const newCel = parseRaw(key, text);
    await replaceCels(state, [{ [key]: newCel }]);
  } catch (e) {
    appendLogEntry({
      cycleNo: ++cycleCounter,
      isError: true,
      header: `#${cycleCounter}  ${key} = ${quote(text)}  →  REJECTED`,
      detail: `${(e as Error).message}\n  reverted to: ${quote(beforeText)}`,
    });
    try { await replaceCels(state, [{ [key]: before }]); } catch { /* swallow */ }
    refreshAllCells();
    selectCell(key);
    return;
  }

  await animateLastCascade(key, text);
};

const animateLastCascade = async (changedKey: CellKey, typedText: string): Promise<void> => {
  const indices = state.input!.get("changeIndices") as Record<string, string[][]> | undefined;
  const waves = indices?.all ?? [];
  const allFired: string[] = [];
  for (const w of waves) for (const k of w) allFired.push(k);

  // Group fired keys by topological layer for a "watch the wavefront" view.
  const byLayer = new Map<number, string[]>();
  for (const k of allFired) {
    const cel = state.Cels.get(k);
    if (!cel) continue;
    const layer = cel.layer ?? 0;
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer)!.push(k);
  }
  const sortedLayers = [...byLayer.keys()].sort((a, b) => a - b);

  cycleCounter++;
  appendLogEntry({
    cycleNo: cycleCounter,
    isError: false,
    header: `#${cycleCounter}  ${changedKey} = ${quote(typedText)}  →  ${allFired.length} cels in ${sortedLayers.length} layer(s)`,
    detail: sortedLayers
      .map(l => `  <span class="layer">layer ${l}</span>: ${
        byLayer.get(l)!.map(k => `<span class="key">${k}</span>`).join(", ")
      }`)
      .join("\n"),
  });

  // Walk layers; reveal each layer's new value, then pulse, then sleep.
  for (const layer of sortedLayers) {
    const keys = byLayer.get(layer)!;
    for (const k of keys) {
      refreshCellDisplay(k);
      pulseCell(k);
    }
    if (layer !== sortedLayers[sortedLayers.length - 1]) {
      await sleep(stepDelay);
    }
  }

  // Refresh the formula bar in case the active cell's value moved.
  ($("#formula-input") as HTMLInputElement).value = rawText(state, activeCell);
};

const pulseCell = (key: CellKey) => {
  const el = cellEl(key);
  if (!el) return;
  el.classList.remove("pulse");
  void el.offsetWidth; // force reflow so the animation restarts
  el.classList.add("pulse");
};

// ---------- Cell rendering ----------

const refreshAllCells = () => {
  for (const k of allKeys()) refreshCellDisplay(k);
};

const refreshCellDisplay = (key: CellKey) => {
  const el = cellEl(key);
  if (!el) return;
  const cel = state.Cels.get(key);
  if (!cel) { el.textContent = ""; return; }

  const errors = state.input!.get("errors") as Record<string, { error: string }> | undefined;
  const err = errors?.[key];

  el.classList.remove("numeric", "error", "formula");
  if (cel.f !== undefined) el.classList.add("formula");
  if (err) {
    el.classList.add("error");
    el.textContent = "#ERR";
    el.title = err.error;
    return;
  }
  el.title = "";

  const v = cel.v;
  if (typeof v === "number") {
    el.classList.add("numeric");
    el.textContent = formatNumber(v);
  } else if (v === null || v === undefined || v === "") {
    el.textContent = "";
  } else if (typeof v === "boolean") {
    el.textContent = v ? "TRUE" : "FALSE";
  } else {
    el.textContent = String(v);
  }
};

const formatNumber = (n: number): string => {
  if (Number.isInteger(n)) return String(n);
  return Number.isFinite(n) ? n.toFixed(4).replace(/\.?0+$/, "") : String(n);
};

// ---------- Formula bar ----------

const wireFormulaBar = () => {
  const input = $("#formula-input") as HTMLInputElement;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
      void commitAndAnimate(activeCell, input.value);
      moveActive(0, 1);
    } else if (e.key === "Escape") {
      input.value = rawText(state, activeCell);
      input.blur();
    }
  });
};

// ---------- Keyboard navigation ----------

const wireKeyboard = () => {
  document.addEventListener("keydown", (e) => {
    // If the formula-bar input is focused, let it handle keys.
    if (document.activeElement === $("#formula-input")) return;

    if (editing) {
      if (e.key === "Enter")  { e.preventDefault(); void finishEdit(true).then(() => moveActive(0, 1)); return; }
      if (e.key === "Tab")    { e.preventDefault(); void finishEdit(true).then(() => moveActive(e.shiftKey ? -1 : 1, 0)); return; }
      if (e.key === "Escape") { e.preventDefault(); void finishEdit(false); return; }
      return;
    }

    if (e.key === "ArrowUp")    { e.preventDefault(); moveActive(0, -1); return; }
    if (e.key === "ArrowDown")  { e.preventDefault(); moveActive(0,  1); return; }
    if (e.key === "ArrowLeft")  { e.preventDefault(); moveActive(-1, 0); return; }
    if (e.key === "ArrowRight" || e.key === "Tab") {
      e.preventDefault();
      moveActive(e.shiftKey ? -1 : 1, 0);
      return;
    }
    if (e.key === "Enter")     { e.preventDefault(); beginEdit(activeCell); return; }
    if (e.key === "F2")        { e.preventDefault(); beginEdit(activeCell); return; }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      void commitAndAnimate(activeCell, "");
      return;
    }
    // Typing a printable character starts an edit primed with that char.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      beginEdit(activeCell, e.key);
    }
  });
};

const moveActive = (dCol: number, dRow: number) => {
  const col = activeCell.charCodeAt(0) - "A".charCodeAt(0);
  const row = parseInt(activeCell.slice(1), 10) - 1;
  const newCol = Math.max(0, Math.min(COLS.length - 1, col + dCol));
  const newRow = Math.max(0, Math.min(ROWS.length - 1, row + dRow));
  selectCell(`${COLS[newCol]}${newRow + 1}`);
};

// ---------- Cascade-log UI ----------

const wireDelayControl = () => {
  const slider = $("#step-delay") as HTMLInputElement;
  const label  = $("#step-delay-label");
  slider.addEventListener("input", () => {
    stepDelay = parseInt(slider.value, 10);
    label.textContent = `${stepDelay}ms`;
  });
};

const wireLogControls = () => {
  $("#clear-log").addEventListener("click", () => {
    $("#cascade-content").innerHTML = "(log cleared)";
  });
};

const appendLogEntry = (entry: { cycleNo: number; isError: boolean; header: string; detail: string }) => {
  const log = $("#cascade-content");
  if (log.textContent?.startsWith("(no edits") || log.textContent === "(log cleared)") {
    log.innerHTML = "";
  }
  const div = document.createElement("div");
  div.className = `log-entry${entry.isError ? " error" : ""}`;
  div.innerHTML = `${escapeHtml(entry.header)}\n${entry.detail}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
};

// ---------- Utils ----------

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const quote = (s: string) => JSON.stringify(s);
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
