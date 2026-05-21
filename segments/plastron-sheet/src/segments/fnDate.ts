import type {
  DehydratedCel, Fn, Segment, SegmentManifest,
} from "../../../../plastron/src/index.js";

// ============================================================================
// sheet:fn:date — date / time function library.
//
// Date representation: ISO-8601 strings. TODAY() returns a "YYYY-MM-DD"
// string; NOW() returns a "YYYY-MM-DDTHH:MM:SSZ" string. YEAR / MONTH
// / DAY / WEEKDAY parse these via the JS Date constructor.
//
// Why strings, not numbers: Excel's serial-number convention (days
// since 1900-01-01, with the famous leap-year-1900 bug) is hostile to
// reading cel values in dehydrated form. ISO strings round-trip
// through JSON, are human-readable in cels, and Date.parse handles
// them. DATEDIF takes either ISO strings or Date instances.
//
// TODAY / NOW are NOT volatile in v1 — they evaluate once at hydrate
// time and stay constant. Mark the calling cels `dynamic: true` to
// refire on every cycle if you need rolling time. (Post-HN: register
// a "now" channel that refreshes the cel value periodically — cleaner
// than dynamic-cel polling.)
// ============================================================================

export const SHEET_FN_DATE_SEGMENT = "sheet:fn:date" as const;

const toS = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
};

/** Parse a string or Date into a JS Date. Returns null on failure
 *  rather than NaN-Date so callers can early-return cleanly. */
const parseDate = (v: unknown): Date | null => {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  if (typeof v === "number") {
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  const s = toS(v).trim();
  if (s === "") return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
};

// ── Implementations ────────────────────────────────────────────────────────

/** "YYYY-MM-DD" for the current local date. */
const fnTODAY = (): string => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

/** ISO instant — full "YYYY-MM-DDTHH:MM:SS.sssZ". */
const fnNOW = (): string => new Date().toISOString();

const fnYEAR  = (v: unknown): number => parseDate(v)?.getFullYear() ?? 0;
const fnMONTH = (v: unknown): number => {
  const d = parseDate(v);
  return d ? d.getMonth() + 1 : 0; // 1-12
};
const fnDAY   = (v: unknown): number => parseDate(v)?.getDate() ?? 0;

/** ISO weekday: Monday=1 .. Sunday=7. (Excel's WEEKDAY defaults to
 *  Sunday=1 .. Saturday=7 with a type=1 argument; the type variants
 *  are a mess. ISO is more useful and consistent.) */
const fnWEEKDAY = (v: unknown): number => {
  const d = parseDate(v);
  if (!d) return 0;
  const js = d.getDay(); // Sun=0..Sat=6
  return js === 0 ? 7 : js;
};

/** Diff between two dates in a given unit. unit: "Y" (years), "M"
 *  (months), "D" (days). Returns 0 for invalid inputs. */
const fnDATEDIF = (start: unknown, end: unknown, unit: unknown = "D"): number => {
  const s = parseDate(start);
  const e = parseDate(end);
  if (!s || !e) return 0;
  const u = String(unit).toUpperCase();
  if (u === "D") {
    return Math.floor((e.getTime() - s.getTime()) / 86400000);
  }
  if (u === "M") {
    let months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
    if (e.getDate() < s.getDate()) months--;
    return months;
  }
  if (u === "Y") {
    let years = e.getFullYear() - s.getFullYear();
    if (e.getMonth() < s.getMonth() ||
        (e.getMonth() === s.getMonth() && e.getDate() < s.getDate())) {
      years--;
    }
    return years;
  }
  return 0;
};

// ── Segment ────────────────────────────────────────────────────────────────

export const buildFnDateSegment = (): Segment => ({
  key: SHEET_FN_DATE_SEGMENT,
  manifest: fnDateManifest,
  cels: [
    { key: "fn:TODAY",   v: fnTODAY   as Fn, segment: SHEET_FN_DATE_SEGMENT },
    { key: "fn:NOW",     v: fnNOW     as Fn, segment: SHEET_FN_DATE_SEGMENT },
    { key: "fn:YEAR",    v: fnYEAR    as Fn, segment: SHEET_FN_DATE_SEGMENT },
    { key: "fn:MONTH",   v: fnMONTH   as Fn, segment: SHEET_FN_DATE_SEGMENT },
    { key: "fn:DAY",     v: fnDAY     as Fn, segment: SHEET_FN_DATE_SEGMENT },
    { key: "fn:WEEKDAY", v: fnWEEKDAY as Fn, segment: SHEET_FN_DATE_SEGMENT },
    { key: "fn:DATEDIF", v: fnDATEDIF as Fn, segment: SHEET_FN_DATE_SEGMENT },
  ] satisfies DehydratedCel[],
});

export const fnDateManifest: SegmentManifest = {
  segment: SHEET_FN_DATE_SEGMENT,
  version: "1.0.0",
  description:
    "Date function library for plastron-sheet — TODAY, NOW, YEAR, " +
    "MONTH, DAY, WEEKDAY, DATEDIF. ISO-8601 string representation " +
    "(not Excel serial-number). ISO weekday convention (Mon=1, Sun=7).",
  provides: {
    celSegments: [SHEET_FN_DATE_SEGMENT],
  },
};
