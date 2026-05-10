import type { Rect } from "./address.js";

// ============================================================================
// TSV — pure builder + parser. The state-touching wrappers (which cel
// values to write, where to paste) live in actions/clipboard.ts.
// ============================================================================

/** Build a TSV string for a rectangular range. The caller supplies
 *  `getValue` so this stays state-agnostic — actions hand in a
 *  closure over `state.cels`. */
export const buildTSV = (
  rect: Rect,
  getValue: (col: number, row: number) => string,
): string => {
  const rows: string[] = [];
  for (let r = rect.r0; r <= rect.r1; r++) {
    const cells: string[] = [];
    for (let c = rect.c0; c <= rect.c1; c++) {
      cells.push(getValue(c, r));
    }
    rows.push(cells.join("\t"));
  }
  return rows.join("\n");
};

/** Parse a clipboard TSV blob into rows × columns. Strips one trailing
 *  newline (typical of clipboard exports) so we don't paste a phantom
 *  empty bottom row. */
export const parseTSV = (text: string): string[][] => {
  const cleaned = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  return cleaned.split("\n").map((line) => line.split("\t"));
};
