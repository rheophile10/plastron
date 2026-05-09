import type { Fn } from "../../../../plastron/src/index.js";
import { el, type VNode } from "../../../../segments/plastron-dom/src/index.js";
import { renderToolbar } from "./toolbar.js";
import { renderGrid } from "./grid.js";
import type { CopyMark } from "../actions/clipboard.js";

// ============================================================================
// App composer — the kernel-facing render fn that gets registered as
// `sheet:render`. Pulls each region's inputs out of the flat input
// record, hands them to the region renderers, returns the combined tree.
// ============================================================================

export const renderApp: Fn = (inputs: Record<string, unknown>): VNode => {
  const selected     = (inputs["__sheet:selected"]     as string) ?? "";
  const selectionEnd = (inputs["__sheet:selectionEnd"] as string) ?? "";
  const editing      = (inputs["__sheet:editing"]      as string) ?? "";
  const editSeed     = (inputs["__sheet:editSeed"]     as string) ?? "";
  const sources      = (inputs["__sheet:sources"]      as Record<string, string>) ?? {};
  const copyMark     = inputs["__sheet:copyMark"] as CopyMark | null;

  return el("div", { class: "sheet" },
    renderToolbar({
      selected,
      selectionEnd,
      sources,
      activeValue: selected ? inputs[selected] : undefined,
    }),
    renderGrid({
      selected,
      selectionEnd,
      editing,
      editSeed,
      sources,
      copyMark,
      cellValue: (addr) => inputs[addr],
    }),
  );
};
