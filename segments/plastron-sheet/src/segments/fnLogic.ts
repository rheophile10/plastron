import type {
  DehydratedCel, Fn, Segment, SegmentManifest,
} from "../../../../plastron/src/index.js";

// ============================================================================
// sheet:fn:logic — boolean / conditional library.
//
// Eager evaluation semantics: IF(cond, then, else) evaluates BOTH
// `then` and `else` arms before picking — same as Excel's volatile
// model and what the compiler's evaluate() naturally produces (args
// resolved before the call). Pure expressions, fine. Document if a
// future short-circuit form lands.
//
// Truthiness shim: empty cells / "" / 0 / null / undefined / false /
// "false" / "FALSE" → false. Everything else → true. Standard Excel-
// ish coercion.
// ============================================================================

export const SHEET_FN_LOGIC_SEGMENT = "sheet:fn:logic" as const;

const toBool = (v: unknown): boolean => {
  if (v === null || v === undefined || v === "") return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") {
    const s = v.toLowerCase().trim();
    return s !== "" && s !== "false" && s !== "0";
  }
  return Boolean(v);
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

const fnIF = (cond: unknown, thenVal: unknown, elseVal: unknown = false): unknown =>
  toBool(cond) ? thenVal : elseVal;

const fnAND = (...args: unknown[]): boolean => {
  for (const v of flatten(args)) if (!toBool(v)) return false;
  // AND with no args is vacuously true in most lisps; Excel returns
  // #VALUE! but vacuous-true is more useful inside formulas.
  return true;
};

const fnOR = (...args: unknown[]): boolean => {
  for (const v of flatten(args)) if (toBool(v)) return true;
  return false;
};

const fnNOT = (v: unknown): boolean => !toBool(v);

const fnIFERROR = (value: unknown, fallback: unknown): unknown => {
  // Error-shaped values in plastron-sheet today: NaN, undefined, or
  // a string starting with "#" (Excel-style #REF!, #VALUE!, etc.).
  // The compiler doesn't yet throw discrete errors; this is a
  // best-effort detection. Future: when fn:VLOOKUP etc. throw real
  // #N/A, IFERROR catches via try/catch.
  if (value === undefined) return fallback;
  if (typeof value === "number" && !Number.isFinite(value)) return fallback;
  if (typeof value === "string" && value.startsWith("#")) return fallback;
  return value;
};

const fnTRUE  = (): boolean => true;
const fnFALSE = (): boolean => false;

// ── Segment ────────────────────────────────────────────────────────────────

export const buildFnLogicSegment = (): Segment => ({
  key: SHEET_FN_LOGIC_SEGMENT,
  manifest: fnLogicManifest,
  cels: [
    { key: "fn:IF",      v: fnIF      as Fn, segment: SHEET_FN_LOGIC_SEGMENT },
    { key: "fn:AND",     v: fnAND     as Fn, segment: SHEET_FN_LOGIC_SEGMENT },
    { key: "fn:OR",      v: fnOR      as Fn, segment: SHEET_FN_LOGIC_SEGMENT },
    { key: "fn:NOT",     v: fnNOT     as Fn, segment: SHEET_FN_LOGIC_SEGMENT },
    { key: "fn:IFERROR", v: fnIFERROR as Fn, segment: SHEET_FN_LOGIC_SEGMENT },
    { key: "fn:TRUE",    v: fnTRUE    as Fn, segment: SHEET_FN_LOGIC_SEGMENT },
    { key: "fn:FALSE",   v: fnFALSE   as Fn, segment: SHEET_FN_LOGIC_SEGMENT },
  ] satisfies DehydratedCel[],
});

export const fnLogicManifest: SegmentManifest = {
  segment: SHEET_FN_LOGIC_SEGMENT,
  version: "1.0.0",
  description:
    "Logic function library for plastron-sheet — IF, AND, OR, NOT, " +
    "IFERROR, TRUE, FALSE. Eager evaluation (both branches of IF " +
    "evaluate); Excel-style truthiness coercion.",
  provides: {
    celSegments: [SHEET_FN_LOGIC_SEGMENT],
  },
};
