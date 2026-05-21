import type {
  DehydratedCel, Fn, Segment, SegmentManifest,
} from "../../../../plastron/src/index.js";

// ============================================================================
// sheet:fn:text — string-manipulation library.
//
// Same pattern as fnMath: native-fn cels keyed fn:<NAME>, kept
// self-contained (helpers inlined into each implementation rather
// than imported across the segment boundary) so the library can ship
// independently as a `.甲` archive once data-3 lands.
//
// Excel-shaped indexing convention: 1-based (LEFT(text, 1) returns the
// first character; FIND returns 1 for a match at the start). NOT 0-
// based as JS String.substring would be — adjust at the boundary.
// ============================================================================

export const SHEET_FN_TEXT_SEGMENT = "sheet:fn:text" as const;

/** Coerce to a string. Numbers print bare; null/undefined → "". */
const toS = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return String(v);
};

const toN = (v: unknown): number => {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const flatten = (args: unknown[]): unknown[] => {
  const out: unknown[] = [];
  for (const a of args) {
    if (Array.isArray(a)) for (const v of a) out.push(v);
    else out.push(a);
  }
  return out;
};

// ── Implementations ────────────────────────────────────────────────────────

const fnCONCAT = (...args: unknown[]): string => {
  let s = "";
  for (const v of flatten(args)) s += toS(v);
  return s;
};

const fnLEFT = (text: unknown, n: unknown = 1): string => {
  const s = toS(text);
  const k = Math.max(0, Math.floor(toN(n)));
  return s.slice(0, k);
};

const fnRIGHT = (text: unknown, n: unknown = 1): string => {
  const s = toS(text);
  const k = Math.max(0, Math.floor(toN(n)));
  return k === 0 ? "" : s.slice(-k);
};

const fnMID = (text: unknown, start: unknown, length: unknown): string => {
  const s = toS(text);
  const i = Math.max(0, Math.floor(toN(start)) - 1); // 1-based → 0-based
  const len = Math.max(0, Math.floor(toN(length)));
  return s.substr(i, len);
};

const fnUPPER = (text: unknown): string => toS(text).toUpperCase();
const fnLOWER = (text: unknown): string => toS(text).toLowerCase();
const fnTRIM  = (text: unknown): string => toS(text).trim();
const fnLEN   = (text: unknown): number => toS(text).length;

const fnFIND = (needle: unknown, haystack: unknown, startNum: unknown = 1): number => {
  const n = toS(needle);
  const h = toS(haystack);
  const startIdx = Math.max(0, Math.floor(toN(startNum)) - 1);
  const idx = h.indexOf(n, startIdx);
  // Excel returns #VALUE! on no match; we return 0 (which IFERROR
  // can catch). Document the deviation.
  return idx < 0 ? 0 : idx + 1;
};

const fnSUBSTITUTE = (
  text: unknown, oldText: unknown, newText: unknown, instanceNum?: unknown,
): string => {
  const s = toS(text);
  const o = toS(oldText);
  const newS = toS(newText);
  if (o === "") return s;
  if (instanceNum === undefined || instanceNum === null || instanceNum === "") {
    // Replace all
    return s.split(o).join(newS);
  }
  const inst = Math.max(1, Math.floor(toN(instanceNum)));
  let count = 0;
  let cursor = 0;
  let out = "";
  while (cursor < s.length) {
    const idx = s.indexOf(o, cursor);
    if (idx < 0) { out += s.slice(cursor); break; }
    count++;
    if (count === inst) {
      out += s.slice(cursor, idx) + newS + s.slice(idx + o.length);
      break;
    }
    out += s.slice(cursor, idx + o.length);
    cursor = idx + o.length;
  }
  return out;
};

const fnREPT = (text: unknown, n: unknown): string => {
  const s = toS(text);
  const k = Math.max(0, Math.floor(toN(n)));
  return s.repeat(k);
};

// ── Segment ────────────────────────────────────────────────────────────────

export const buildFnTextSegment = (): Segment => ({
  key: SHEET_FN_TEXT_SEGMENT,
  manifest: fnTextManifest,
  cels: [
    { key: "fn:CONCAT",     v: fnCONCAT     as Fn, segment: SHEET_FN_TEXT_SEGMENT },
    { key: "fn:LEFT",       v: fnLEFT       as Fn, segment: SHEET_FN_TEXT_SEGMENT },
    { key: "fn:RIGHT",      v: fnRIGHT      as Fn, segment: SHEET_FN_TEXT_SEGMENT },
    { key: "fn:MID",        v: fnMID        as Fn, segment: SHEET_FN_TEXT_SEGMENT },
    { key: "fn:UPPER",      v: fnUPPER      as Fn, segment: SHEET_FN_TEXT_SEGMENT },
    { key: "fn:LOWER",      v: fnLOWER      as Fn, segment: SHEET_FN_TEXT_SEGMENT },
    { key: "fn:TRIM",       v: fnTRIM       as Fn, segment: SHEET_FN_TEXT_SEGMENT },
    { key: "fn:LEN",        v: fnLEN        as Fn, segment: SHEET_FN_TEXT_SEGMENT },
    { key: "fn:FIND",       v: fnFIND       as Fn, segment: SHEET_FN_TEXT_SEGMENT },
    { key: "fn:SUBSTITUTE", v: fnSUBSTITUTE as Fn, segment: SHEET_FN_TEXT_SEGMENT },
    { key: "fn:REPT",       v: fnREPT       as Fn, segment: SHEET_FN_TEXT_SEGMENT },
  ] satisfies DehydratedCel[],
});

export const fnTextManifest: SegmentManifest = {
  segment: SHEET_FN_TEXT_SEGMENT,
  version: "1.0.0",
  description:
    "Text function library for plastron-sheet — CONCAT, LEFT, RIGHT, " +
    "MID, UPPER, LOWER, TRIM, LEN, FIND, SUBSTITUTE, REPT. Excel-shaped " +
    "1-based indexing. FIND returns 0 on miss (Excel returns #VALUE!).",
  provides: {
    celSegments: [SHEET_FN_TEXT_SEGMENT],
  },
};
