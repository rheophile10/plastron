import type { CelTriple, DehydratedCel, Fn, State } from "../../../../plastron/src/index.js";
import { COLS, ROWS, addressOf, parseAddress, rectFor } from "../domain/address.js";
import {
  classifyInput, cellKeyFor, buildFormulaInputMap, DEFAULT_SHEET_NAME,
} from "../domain/parse.js";
import { infixFormula } from "../formula.js";
import { buildTSV, parseTSV } from "../domain/tsv.js";

/** Convert a `classifyInput` DehydratedCel into a CelTriple for
 *  setCelBatch. See cell.ts for the longer version of this comment;
 *  duplicated here to keep clipboard.ts self-contained. */
const dcToTriple = (dc: DehydratedCel): CelTriple =>
  dc.f !== undefined
    ? { f: dc.f, l: null }
    : { v: dc.v ?? "", f: null, l: null };

/** Read the active user sheet from the controls cel. Falls back to
 *  the default sheet so this works before installSheet completes. */
const activeSheetOf = (state: State): string =>
  (state.cels.get("__sheet:activeSheet")?.v as string | undefined) ?? DEFAULT_SHEET_NAME;

// ============================================================================
// Clipboard actions — copy / cut / paste / clear, plus the marching-
// ants "copy mark" lifecycle. All driven by the document-level
// listeners installed in bridges/clipboard.ts.
// ============================================================================

export interface CopyMark {
  start: string;
  end: string;
  /** "cut" tells paste to clear the source rectangle after writing
   *  the destination. "copy" leaves the source alone. */
  mode: "copy" | "cut";
}

const cellClipboardValue = (state: State, addr: string): string => {
  const sheet = activeSheetOf(state);
  const v = state.cels.get(cellKeyFor(sheet, addr))?.v;
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);
  return String(v);
};

/** Build a TSV string of the current selection plus the canonical
 *  start/end addresses. Returns null when there's nothing selected. */
const selectionAsTSV = (
  state: State,
): { tsv: string; start: string; end: string } | null => {
  const start = (state.cels.get("__sheet:selected")?.v as string) ?? "";
  const end   = (state.cels.get("__sheet:selectionEnd")?.v as string) ?? "";
  if (!start) return null;
  const rect = rectFor(start, end || start);
  if (!rect) return null;

  const tsv = buildTSV(rect, (c, r) => cellClipboardValue(state, addressOf(c, r)));
  return { tsv, start, end: end || start };
};

/** Write the active selection to the clipboard event as TSV. Returns
 *  true if anything was written. */
export const copySelectionTo = (state: State, event: ClipboardEvent): boolean => {
  const sel = selectionAsTSV(state);
  if (!sel) return false;
  event.clipboardData?.setData("text/plain", sel.tsv);
  event.preventDefault();
  void (state.fns.get("set") as Fn)(state, "__sheet:copyMark", {
    start: sel.start, end: sel.end, mode: "copy",
  } satisfies CopyMark);
  return true;
};

/** Cut: same TSV as copy, but the marker is "cut" so paste will
 *  clear the source rectangle afterwards. The source cells are
 *  intentionally NOT cleared yet — they stay visible until paste
 *  lands (or the user cancels). */
export const cutSelectionTo = (state: State, event: ClipboardEvent): boolean => {
  const sel = selectionAsTSV(state);
  if (!sel) return false;
  event.clipboardData?.setData("text/plain", sel.tsv);
  event.preventDefault();
  void (state.fns.get("set") as Fn)(state, "__sheet:copyMark", {
    start: sel.start, end: sel.end, mode: "cut",
  } satisfies CopyMark);
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

  const rows = parseTSV(text);

  const sheet = activeSheetOf(state);
  const sources = (state.cels.get("__sheet:sources")?.v as Record<string, string>) ?? {};
  const nextSources: Record<string, string> = { ...sources };
  const triples: Record<string, CelTriple> = {};
  const pasteAddrs = new Set<string>();
  // Track formula-cel inputMap updates — CelTriple doesn't carry
  // inputMap today, so we apply them out-of-band before the cascade.
  const formulaInputMapPatches: Array<[string, Record<string, string>]> = [];

  for (let dr = 0; dr < rows.length; dr++) {
    const row = rows[dr]!;
    for (let dc = 0; dc < row.length; dc++) {
      const c = startPos.col + dc;
      const r = startPos.row + dr;
      if (c >= COLS || r >= ROWS) continue;
      const addr = addressOf(c, r);
      pasteAddrs.add(addr);
      const key = cellKeyFor(sheet, addr);
      const cd = classifyInput(addr, row[dc]!.trim(), nextSources, sheet);
      triples[key] = dcToTriple(cd);
      if (cd.f !== undefined) {
        const deps = infixFormula.extractDeps?.(cd.f) ?? [];
        formulaInputMapPatches.push([key, buildFormulaInputMap(sheet, deps)]);
      }
    }
  }
  if (Object.keys(triples).length === 0) return false;

  // If the marker says "cut", clear the source rectangle — except
  // cells that overlap with the paste destination.
  const mark = state.cels.get("__sheet:copyMark")?.v as CopyMark | null;
  if (mark?.mode === "cut") {
    const cutRect = rectFor(mark.start, mark.end);
    if (cutRect) {
      for (let r = cutRect.r0; r <= cutRect.r1; r++) {
        for (let c = cutRect.c0; c <= cutRect.c1; c++) {
          const addr = addressOf(c, r);
          if (pasteAddrs.has(addr)) continue;
          triples[cellKeyFor(sheet, addr)] = { v: "", f: null, l: null };
          delete nextSources[addr];
        }
      }
    }
  }

  event.preventDefault();

  // Bundle the cell-role changes + bookkeeping into ONE setCelBatch
  // call so the cascade fires once for the union of affected keys.
  // Previously: hydrate → runCycle → set → set → set (5+ cascades).
  triples["__sheet:sources"]  = { v: nextSources };
  triples["__sheet:copyMark"] = { v: null };
  // Move selection extent to cover the pasted block.
  const lastC = Math.min(COLS - 1, startPos.col + Math.max(...rows.map((r) => r.length)) - 1);
  const lastR = Math.min(ROWS - 1, startPos.row + rows.length - 1);
  if (lastC > startPos.col || lastR > startPos.row) {
    triples["__sheet:selectionEnd"] = { v: addressOf(lastC, lastR) };
  }

  // Apply formula-cel inputMap rewrites out-of-band before the cascade
  // (CelTriple doesn't carry inputMap today; followup to extend it).
  for (const [key, im] of formulaInputMapPatches) {
    const cel = state.cels.get(key);
    if (cel) cel.inputMap = im;
  }

  const setCelBatch = state.fns.get("setCelBatch") as Fn;
  await setCelBatch(state, triples);
  return true;
};

/** Clear the contents of every cell in the active selection. Formula
 *  sources for those cells are also dropped from the sources map. */
export const clearSelection: Fn = async (...args: unknown[]) => {
  const [state] = args as [State];
  const start = (state.cels.get("__sheet:selected")?.v as string) ?? "";
  const end   = (state.cels.get("__sheet:selectionEnd")?.v as string) ?? "";
  if (!start) return;
  const rect = rectFor(start, end || start);
  if (!rect) return;

  const sheet = activeSheetOf(state);
  const sources = (state.cels.get("__sheet:sources")?.v as Record<string, string>) ?? {};
  const nextSources: Record<string, string> = { ...sources };
  const triples: Record<string, CelTriple> = {};
  for (let r = rect.r0; r <= rect.r1; r++) {
    for (let c = rect.c0; c <= rect.c1; c++) {
      const addr = addressOf(c, r);
      triples[cellKeyFor(sheet, addr)] = { v: "", f: null, l: null };
      delete nextSources[addr];
    }
  }
  triples["__sheet:sources"] = { v: nextSources };

  // One cascade for the union (was hydrate → runCycle → set: 3
  // cascades). Cookbook §3b + §13.
  await (state.fns.get("setCelBatch") as Fn)(state, triples);
};

/** Clear the marching-ants overlay (Escape, or any other "cancel
 *  copy" trigger). */
export const clearCopyMark = async (state: State): Promise<void> => {
  if (state.cels.get("__sheet:copyMark")?.v == null) return;
  await (state.fns.get("set") as Fn)(state, "__sheet:copyMark", null);
};
