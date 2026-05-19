import type {
  DehydratedCel, Fn, Segment, SegmentManifest,
} from "../../../../plastron/src/index.js";

// ============================================================================
// sheet:fn:math — the math function library.
//
// Hydrates native-fn cels keyed `fn:SUM`, `fn:AVG`, … into the
// `sheet:fn:math` segment. Each cel's `v` IS the JS implementation;
// the infix compiler in `formula.ts` resolves bare-atom function calls
// (`SUM(A1:A10)`) by looking up `inputs["fn:SUM"]` at evaluate time.
//
// Per the Phase 3 design, function libraries are independent B2-flavor
// segments — hidden from the visible tab bar, replaceable via flush +
// re-hydrate, dehydrated alongside everything else. Adding a function
// library = hydrating a segment. Removing one = `flush(state,
// "sheet:fn:math")`.
//
// Implementations accept their args verbatim from the compiler, which
// passes ranges as JS arrays. The flatten/coerce step inside each fn
// handles the variadic `SUM(A1, B2:B10, C3)` shape uniformly.
// ============================================================================

export const SHEET_FN_MATH_SEGMENT = "sheet:fn:math" as const;

/** Coerce a value to a number; empty / null / non-numeric → 0. Same
 *  policy as the compiler's `toNumber`, duplicated here so this
 *  segment can be flushed/replaced without depending on the compiler
 *  internals. */
const toN = (v: unknown): number => {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Flatten args (variadic mix of scalars and arrays from range refs)
 *  into a flat array of values. */
const flatten = (args: unknown[]): unknown[] => {
  const out: unknown[] = [];
  for (const a of args) {
    if (Array.isArray(a)) for (const v of a) out.push(v);
    else out.push(a);
  }
  return out;
};

// ── Implementations ────────────────────────────────────────────────────────

const fnSUM   = (...args: unknown[]): number => {
  let t = 0;
  for (const v of flatten(args)) t += toN(v);
  return t;
};

const fnAVG = (...args: unknown[]): number => {
  const vs = flatten(args);
  if (vs.length === 0) return 0;
  let t = 0;
  for (const v of vs) t += toN(v);
  return t / vs.length;
};

const fnMIN = (...args: unknown[]): number => {
  const vs = flatten(args);
  if (vs.length === 0) return 0;
  let m = Infinity;
  for (const v of vs) { const n = toN(v); if (n < m) m = n; }
  return Number.isFinite(m) ? m : 0;
};

const fnMAX = (...args: unknown[]): number => {
  const vs = flatten(args);
  if (vs.length === 0) return 0;
  let m = -Infinity;
  for (const v of vs) { const n = toN(v); if (n > m) m = n; }
  return Number.isFinite(m) ? m : 0;
};

const fnCOUNT = (...args: unknown[]): number => {
  let n = 0;
  for (const v of flatten(args)) {
    // Excel COUNT semantics: numeric values only. Strings (even
    // numeric-looking strings) and empty cells don't count.
    if (typeof v === "number" && Number.isFinite(v)) n++;
  }
  return n;
};

const fnROUND = (value: unknown, digits: unknown): number => {
  const v = toN(value);
  const d = toN(digits);
  const factor = Math.pow(10, d);
  return Math.round(v * factor) / factor;
};

const fnABS  = (value: unknown): number => Math.abs(toN(value));
const fnSQRT = (value: unknown): number => Math.sqrt(toN(value));
const fnPOW  = (base: unknown, exp: unknown): number => Math.pow(toN(base), toN(exp));

// ── Segment construction ───────────────────────────────────────────────────

/** Build the dehydrated cels for the math function library. The
 *  cels are native-fn cels — `v` is the JS implementation, referenced
 *  by `fn:<NAME>` from the infix compiler's call resolution.
 *
 *  These functions don't round-trip through `dehydrate`/`exportArchive`
 *  meaningfully (the JS closures don't serialize); the host calls
 *  `buildFnMathSegment()` again at install time on the receiving end
 *  so the registry is reconstructed locally. */
export const buildFnMathSegment = (): Segment => ({
  key: SHEET_FN_MATH_SEGMENT,
  manifest: fnMathManifest,
  cels: [
    { key: "fn:SUM",   v: fnSUM   as Fn, segment: SHEET_FN_MATH_SEGMENT },
    { key: "fn:AVG",   v: fnAVG   as Fn, segment: SHEET_FN_MATH_SEGMENT },
    { key: "fn:MIN",   v: fnMIN   as Fn, segment: SHEET_FN_MATH_SEGMENT },
    { key: "fn:MAX",   v: fnMAX   as Fn, segment: SHEET_FN_MATH_SEGMENT },
    { key: "fn:COUNT", v: fnCOUNT as Fn, segment: SHEET_FN_MATH_SEGMENT },
    { key: "fn:ROUND", v: fnROUND as Fn, segment: SHEET_FN_MATH_SEGMENT },
    { key: "fn:ABS",   v: fnABS   as Fn, segment: SHEET_FN_MATH_SEGMENT },
    { key: "fn:SQRT",  v: fnSQRT  as Fn, segment: SHEET_FN_MATH_SEGMENT },
    { key: "fn:POW",   v: fnPOW   as Fn, segment: SHEET_FN_MATH_SEGMENT },
  ] satisfies DehydratedCel[],
});

export const fnMathManifest: SegmentManifest = {
  segment: SHEET_FN_MATH_SEGMENT,
  version: "1.0.0",
  description:
    "Math function library for plastron-sheet — SUM, AVG, MIN, MAX, " +
    "COUNT, ROUND, ABS, SQRT, POW as native-fn cels keyed fn:<NAME>. " +
    "Hidden by default; users invoke via `=SUM(A1:A10)` style formulas.",
  provides: {
    celSegments: [SHEET_FN_MATH_SEGMENT],
  },
};
