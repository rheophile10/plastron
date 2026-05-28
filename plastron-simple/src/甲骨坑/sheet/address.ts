// ============================================================================
// A1-notation address utilities for the spreadsheet segment. Cell cels are
// keyed `sheet.<ADDR>` (e.g. sheet.A1); the infix parser resolves a bare
// reference A1 to that key through CELL_PREFIX. Carried forward in spirit
// from the legacy plastron-sheet domain/address.ts.
// ============================================================================

export const CELL_PREFIX = "sheet." as const;

/** Column letters → 0-based index. A→0, Z→25, AA→26, AB→27, … */
export const colToIndex = (letters: string): number => {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) - 64); // 'A' = 65 → 1
  }
  return n - 1;
};

/** 0-based column index → letters. 0→A, 25→Z, 26→AA, … */
export const indexToCol = (index: number): string => {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

export interface CellRef { col: number; row: number; }

const REF_RE = /^([A-Za-z]+)([0-9]+)$/;

/** Parse "B3" → { col: 1, row: 2 } (both 0-based). Null if not a ref. */
export const parseRef = (ref: string): CellRef | null => {
  const m = REF_RE.exec(ref);
  if (!m) return null;
  return { col: colToIndex(m[1]!.toUpperCase()), row: parseInt(m[2]!, 10) - 1 };
};

/** { col, row } (0-based) → "B3". */
export const addrFrom = (col: number, row: number): string =>
  `${indexToCol(col)}${row + 1}`;

/** Cell key for an address: "A1" → "sheet.A1". */
export const cellKey = (addr: string): string => CELL_PREFIX + addr;

/** Expand "A1:B2" into its member addresses (row-major). A single ref
 *  (no colon) expands to itself. Returns [] for an unparseable range. */
export const expandRange = (range: string): string[] => {
  const colon = range.indexOf(":");
  if (colon === -1) {
    const r = parseRef(range);
    return r ? [range.toUpperCase()] : [];
  }
  const a = parseRef(range.slice(0, colon));
  const b = parseRef(range.slice(colon + 1));
  if (!a || !b) return [];
  const c0 = Math.min(a.col, b.col), c1 = Math.max(a.col, b.col);
  const r0 = Math.min(a.row, b.row), r1 = Math.max(a.row, b.row);
  const out: string[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) out.push(addrFrom(c, r));
  }
  return out;
};
