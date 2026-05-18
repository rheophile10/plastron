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

export const SHEET_SEGMENT = "sheet" as const;

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
