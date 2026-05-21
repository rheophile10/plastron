import type {
  DehydratedCel, Fn, Segment, SegmentManifest,
} from "../../../../plastron/src/index.js";

// ============================================================================
// sheet:fn:stats — descriptive-statistics library.
//
// Standard frequency-based stats over a flat range. Aggregates ignore
// non-numeric values (empty cells, strings) — matches Excel's "ignore
// text" behavior for STDEV / VAR / MEDIAN / etc.
// ============================================================================

export const SHEET_FN_STATS_SEGMENT = "sheet:fn:stats" as const;

const flatten = (args: unknown[]): unknown[] => {
  const out: unknown[] = [];
  for (const a of args) {
    if (Array.isArray(a)) for (const v of a) out.push(v);
    else out.push(a);
  }
  return out;
};

/** Pull the numeric values out of the arg list, ignoring strings,
 *  empties, and other non-numeric entries. */
const nums = (args: unknown[]): number[] => {
  const out: number[] = [];
  for (const v of flatten(args)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      out.push(v);
    }
  }
  return out;
};

// ── Implementations ────────────────────────────────────────────────────────

/** Sample standard deviation (n - 1 denominator). Returns 0 for n < 2. */
const fnSTDEV = (...args: unknown[]): number => {
  const xs = nums(args);
  if (xs.length < 2) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  const mean = sum / xs.length;
  let sq = 0;
  for (const x of xs) { const d = x - mean; sq += d * d; }
  return Math.sqrt(sq / (xs.length - 1));
};

/** Sample variance (n - 1 denominator). Returns 0 for n < 2. */
const fnVAR = (...args: unknown[]): number => {
  const xs = nums(args);
  if (xs.length < 2) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  const mean = sum / xs.length;
  let sq = 0;
  for (const x of xs) { const d = x - mean; sq += d * d; }
  return sq / (xs.length - 1);
};

const fnMEDIAN = (...args: unknown[]): number => {
  const xs = nums(args).slice().sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 0 ? (xs[mid - 1]! + xs[mid]!) / 2 : xs[mid]!;
};

/** Most-frequent value. Ties broken by first occurrence in the input
 *  order (Excel returns the smallest, but first-occurrence is more
 *  intuitive — flag as a deviation if surfaced). */
const fnMODE = (...args: unknown[]): number => {
  const xs = nums(args);
  if (xs.length === 0) return 0;
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best = xs[0]!;
  let bestCount = 0;
  for (const x of xs) {
    const c = counts.get(x)!;
    if (c > bestCount) { best = x; bestCount = c; }
  }
  return best;
};

/** Rank of `value` within `range` (1 = largest by default). Optional
 *  `order` flag: 0/false (default) descending, non-zero ascending. */
const fnRANK = (value: unknown, range: unknown, order: unknown = 0): number => {
  const target = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(target)) return 0;
  const xs = nums(Array.isArray(range) ? range : [range]);
  const asc = typeof order === "number" ? order !== 0 :
              typeof order === "boolean" ? order :
              order != null && order !== "" && order !== "0" && order !== "false";
  let rank = 1;
  for (const x of xs) {
    if (asc ? x < target : x > target) rank++;
  }
  // If target isn't in the range, Excel returns #N/A; we return rank
  // anyway (treating it as "where it would slot").
  return rank;
};

const fnCOUNTA = (...args: unknown[]): number => {
  // Count non-empty values (any type). Distinct from COUNT in fnMath
  // which counts only numerics.
  let n = 0;
  for (const v of flatten(args)) {
    if (v !== null && v !== undefined && v !== "") n++;
  }
  return n;
};

// ── Segment ────────────────────────────────────────────────────────────────

export const buildFnStatsSegment = (): Segment => ({
  key: SHEET_FN_STATS_SEGMENT,
  manifest: fnStatsManifest,
  cels: [
    { key: "fn:STDEV",  v: fnSTDEV  as Fn, segment: SHEET_FN_STATS_SEGMENT },
    { key: "fn:VAR",    v: fnVAR    as Fn, segment: SHEET_FN_STATS_SEGMENT },
    { key: "fn:MEDIAN", v: fnMEDIAN as Fn, segment: SHEET_FN_STATS_SEGMENT },
    { key: "fn:MODE",   v: fnMODE   as Fn, segment: SHEET_FN_STATS_SEGMENT },
    { key: "fn:RANK",   v: fnRANK   as Fn, segment: SHEET_FN_STATS_SEGMENT },
    { key: "fn:COUNTA", v: fnCOUNTA as Fn, segment: SHEET_FN_STATS_SEGMENT },
  ] satisfies DehydratedCel[],
});

export const fnStatsManifest: SegmentManifest = {
  segment: SHEET_FN_STATS_SEGMENT,
  version: "1.0.0",
  description:
    "Descriptive-statistics library for plastron-sheet — STDEV, VAR, " +
    "MEDIAN, MODE, RANK, COUNTA. Sample-variance (n-1) convention. " +
    "Non-numeric values silently dropped from aggregates.",
  provides: {
    celSegments: [SHEET_FN_STATS_SEGMENT],
  },
};
