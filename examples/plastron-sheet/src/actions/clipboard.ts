import type { DehydratedCel, Fn, State } from "../../../../plastron/src/index.js";
import { COLS, ROWS, addressOf, parseAddress, rectFor } from "../domain/address.js";
import { SHEET_SEGMENT, classifyInput } from "../domain/parse.js";
import { buildTSV, parseTSV } from "../domain/tsv.js";

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
  const v = state.cels.get(addr)?.v;
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

  const sources = (state.cels.get("__sheet:sources")?.v as Record<string, string>) ?? {};
  const nextSources: Record<string, string> = { ...sources };
  const cels: DehydratedCel[] = [];
  const pasteAddrs = new Set<string>();

  for (let dr = 0; dr < rows.length; dr++) {
    const row = rows[dr]!;
    for (let dc = 0; dc < row.length; dc++) {
      const c = startPos.col + dc;
      const r = startPos.row + dr;
      if (c >= COLS || r >= ROWS) continue;
      const addr = addressOf(c, r);
      pasteAddrs.add(addr);
      cels.push(classifyInput(addr, row[dc]!.trim(), nextSources));
    }
  }
  if (cels.length === 0) return false;

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
          cels.push({ key: addr, v: "", segment: SHEET_SEGMENT });
          delete nextSources[addr];
        }
      }
    }
  }

  event.preventDefault();
  const hydrate = state.fns.get("hydrate") as Fn;
  const setFn = state.fns.get("set") as Fn;
  hydrate(state, [{ key: SHEET_SEGMENT, cels }], []);
  await (state.fns.get("runCycle") as Fn)(state);
  await setFn(state, "__sheet:sources", nextSources);

  // Move selection extent to cover the pasted block.
  const lastC = Math.min(COLS - 1, startPos.col + Math.max(...rows.map((r) => r.length)) - 1);
  const lastR = Math.min(ROWS - 1, startPos.row + rows.length - 1);
  if (lastC > startPos.col || lastR > startPos.row) {
    await setFn(state, "__sheet:selectionEnd", addressOf(lastC, lastR));
  }
  // Pasting consumes the copy/cut.
  await setFn(state, "__sheet:copyMark", null);
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

  const sources = (state.cels.get("__sheet:sources")?.v as Record<string, string>) ?? {};
  const nextSources: Record<string, string> = { ...sources };
  const cels: DehydratedCel[] = [];
  for (let r = rect.r0; r <= rect.r1; r++) {
    for (let c = rect.c0; c <= rect.c1; c++) {
      const addr = addressOf(c, r);
      cels.push({ key: addr, v: "", segment: SHEET_SEGMENT });
      delete nextSources[addr];
    }
  }

  const hydrate = state.fns.get("hydrate") as Fn;
  hydrate(state, [{ key: SHEET_SEGMENT, cels }], []);
  await (state.fns.get("runCycle") as Fn)(state);
  await (state.fns.get("set") as Fn)(state, "__sheet:sources", nextSources);
};

/** Clear the marching-ants overlay (Escape, or any other "cancel
 *  copy" trigger). */
export const clearCopyMark = async (state: State): Promise<void> => {
  if (state.cels.get("__sheet:copyMark")?.v == null) return;
  await (state.fns.get("set") as Fn)(state, "__sheet:copyMark", null);
};
