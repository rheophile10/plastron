import type { Fn } from "../../../../plastron/src/index.js";
import { el, type VNode } from "../../../plastron-dom/src/index.js";
import { renderToolbar } from "./toolbar.js";
import { renderGrid } from "./grid.js";
import { renderTabs } from "./tabs.js";
import type { CopyMark } from "../actions/clipboard.js";
import { DEFAULT_SHEET_NAME } from "../domain/parse.js";

// ============================================================================
// App composer — the kernel-facing render fn that gets registered as
// `sheet:render`. Pulls each region's inputs out of the flat input
// record, hands them to the region renderers, returns the combined tree.
//
// Multi-sheet shape: cell-cel inputs are keyed `${sheetName}!${addr}`
// in the inputMap so all sheets' cells flow into this render. The
// active-sheet narrowing happens here (cellValue closes over the
// active sheet name and prefixes lookups). Switching sheets is a
// `set("__sheet:activeSheet", name)` — the cascade re-fires this
// lambda, which then reads through the new prefix.
// ============================================================================

export const renderApp: Fn = (inputs: Record<string, unknown>): VNode => {
  const selected     = (inputs["__sheet:selected"]     as string) ?? "";
  const selectionEnd = (inputs["__sheet:selectionEnd"] as string) ?? "";
  const editing      = (inputs["__sheet:editing"]      as string) ?? "";
  const editSeed     = (inputs["__sheet:editSeed"]     as string) ?? "";
  const sources      = (inputs["__sheet:sources"]      as Record<string, string>) ?? {};
  const copyMark     = inputs["__sheet:copyMark"] as CopyMark | null;
  const active       = (inputs["__sheet:activeSheet"]  as string) ?? DEFAULT_SHEET_NAME;
  const userSheets   = (inputs["__sheet:userSheets"]   as ReadonlyArray<string>) ?? [active];

  /** Look up a cell value in the active sheet. The inputMap on the
   *  appTree cel keys cell inputs as `${sheet}!${addr}`, so the
   *  active-sheet narrowing is just a string concat. */
  const cellValue = (addr: string): unknown => inputs[`${active}!${addr}`];

  return el("div", { class: "sheet" },
    renderTabs({ sheets: userSheets, active }),
    renderToolbar({
      selected,
      selectionEnd,
      sources,
      activeValue: selected ? cellValue(selected) : undefined,
    }),
    renderGrid({
      selected,
      selectionEnd,
      editing,
      editSeed,
      sources,
      copyMark,
      cellValue,
    }),
  );
};
