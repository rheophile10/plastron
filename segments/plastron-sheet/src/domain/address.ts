// ============================================================================
// Address helpers — pure, platform-agnostic. The kernel and the DOM
// don't appear in this file. Anything that can be tested with a
// stopwatch and a calculator lives here.
// ============================================================================

export const COLS = 8;
export const ROWS = 12;

export const colLetter = (c: number): string => String.fromCharCode(65 + c);

export const addressOf = (col: number, row: number): string =>
  `${colLetter(col)}${row + 1}`;

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

export interface Rect { c0: number; r0: number; c1: number; r1: number }

export const rectFor = (start: string, end: string): Rect | null => {
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
