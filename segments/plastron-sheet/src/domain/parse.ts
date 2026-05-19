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

/** Build a dehydrated cel from raw user-input text and update the
 *  formula-source side-table. `"=…"` becomes a formula cel; numeric
 *  strings become numbers; everything else stays as a string. */
export const classifyInput = (
  addr: string,
  trimmed: string,
  sources: Record<string, string>,
): DehydratedCel => {
  if (trimmed === "") {
    delete sources[addr];
    return { key: addr, v: "", segment: SHEET_SEGMENT };
  }
  if (trimmed.startsWith("=")) {
    const src = trimmed.slice(1).trim();
    sources[addr] = src;
    return { key: addr, f: src, segment: SHEET_SEGMENT };
  }
  const num = Number(trimmed);
  delete sources[addr];
  if (Number.isFinite(num) && trimmed !== "") {
    return { key: addr, v: num, segment: SHEET_SEGMENT };
  }
  return { key: addr, v: trimmed, segment: SHEET_SEGMENT };
};

// displayValue moved to plastron-dom; re-exported from this segment's
// index.ts to preserve the public surface.
