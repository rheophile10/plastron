import type { DehydratedCel } from "../../../../plastron/src/index.js";

// ============================================================================
// User-input parsing + value display. Pure helpers — given a string,
// produce a dehydrated cel; given a value, produce a printable string.
// No kernel access, no DOM.
//
// classifyInput mutates the caller-supplied `sources` map as a side
// effect (set on formula, delete otherwise). The caller is expected
// to pass a fresh-cloned copy and then write the result back into
// state via `set("__sheet:sources", nextSources)`.
// ============================================================================

// ── Segment naming ──────────────────────────────────────────────────────────
//
// The plastron-sheet family of segments. Per the Phase 3 design in
// notes/todo.md, each role lives in its own segment so they can be
// hidden / replaced / flushed independently:
//
//   sheet:controls   workbook-level state — selected, editing,
//                    sources, copyMark, activeSheet, the appTree
//                    render cel, and the bridge-disposer sentinel.
//                    SHEET_CONTROLS_SEGMENT.
//   sheet:<Name>     user-visible sheet of cells. One per sheet.
//                    Step 1 ships only "sheet:Sheet1"; multi-sheet
//                    support lands in Phase 3 step 3.
//                    sheetSegmentFor(name).
//
// SHEET_SEGMENT is retained as the segment value for the *default*
// user sheet's cells (i.e. `sheetSegmentFor(DEFAULT_SHEET_NAME)`).
// Existing callers of classifyInput continue to work without changes.

export const SHEET_CONTROLS_SEGMENT = "sheet:controls" as const;

/** The default user-sheet's display name. Step 1 only ships this one;
 *  Phase 3 step 3 introduces user-renamable sheets. */
export const DEFAULT_SHEET_NAME = "Sheet1" as const;

/** Build the segment key for a user sheet given its display name. */
export const sheetSegmentFor = (name: string): `sheet:${string}` =>
  `sheet:${name}`;

/** Convenience alias for the default user sheet's segment. Equivalent
 *  to `sheetSegmentFor(DEFAULT_SHEET_NAME)` — kept as a const so it
 *  can be used as a `const`-typed segment value at hydrate time. */
export const SHEET_SEGMENT = sheetSegmentFor(DEFAULT_SHEET_NAME);

/** Build a fully-qualified cel key for a cell of a given sheet.
 *  `cellKeyFor("Sheet1", "A1")` → `"Sheet1:A1"`. Cel keys are flat
 *  across `state.cels`, so multi-sheet support requires sheet-
 *  prefixed keys to keep cells of different sheets distinct.
 *
 *  In-sheet bookkeeping (selection, editing) continues to store
 *  bare addresses ("A1") — the host pairs them with `activeSheet`
 *  at read time to derive the full key. */
export const cellKeyFor = (sheet: string, addr: string): string =>
  `${sheet}:${addr}`;

/** Translate the bare-name deps of an infix formula (cell refs like
 *  "A1", function-library refs like "fn:SUM") into an inputMap that
 *  scopes cell refs to the given user sheet while leaving function-
 *  library refs as global keys. Used at hydrate time for seeded
 *  formula cels AND at runtime by `commitFromInput` when the user
 *  enters a formula whose dependency set may have changed.
 *
 *  Function libraries are workbook-wide (the `sheet:fn:math` segment
 *  lives once for the whole workbook), so `fn:SUM` resolves to
 *  itself. Cell refs are sheet-scoped, so `A1` resolves to
 *  `${sheet}:A1`. */
export const buildFormulaInputMap = (
  sheet: string,
  deps: readonly string[],
): Record<string, string> => {
  const map: Record<string, string> = {};
  for (const dep of deps) {
    map[dep] = dep.startsWith("fn:") ? dep : cellKeyFor(sheet, dep);
  }
  return map;
};

/** Build a dehydrated cel from raw user-input text and update the
 *  formula-source side-table. `"=…"` becomes a formula cel; numeric
 *  strings become numbers; everything else stays as a string.
 *
 *  `addr` is the in-sheet address ("A1", "B5"). `sheet` is the
 *  active user-sheet name (e.g. "Sheet1"). The returned dehydrated
 *  cel's `key` is the fully-qualified sheet:addr form so it sits in
 *  the right segment without collisions. The sources side-table is
 *  still keyed by bare addr — sources is per-sheet (lives in
 *  __sheet:sources, which the host maintains per active sheet). */
export const classifyInput = (
  addr: string,
  trimmed: string,
  sources: Record<string, string>,
  sheet: string = DEFAULT_SHEET_NAME,
): DehydratedCel => {
  const segment = sheetSegmentFor(sheet);
  const key = cellKeyFor(sheet, addr);
  if (trimmed === "") {
    delete sources[addr];
    return { key, v: "", segment };
  }
  if (trimmed.startsWith("=")) {
    const src = trimmed.slice(1).trim();
    sources[addr] = src;
    return { key, f: src, segment };
  }
  const num = Number(trimmed);
  delete sources[addr];
  if (Number.isFinite(num) && trimmed !== "") {
    return { key, v: num, segment };
  }
  return { key, v: trimmed, segment };
};

// displayValue moved to plastron-dom; re-exported from this segment's
// index.ts to preserve the public surface.
