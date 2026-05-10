import { el, type VNode } from "../../../plastron-dom/src/index.js";
import { displayValue } from "../domain/parse.js";

// ============================================================================
// Toolbar — name box on the left, formula bar on the right. Pure
// render: takes inputs, returns vnode.
// ============================================================================

export interface ToolbarInputs {
  selected: string;
  selectionEnd: string;
  sources: Record<string, string>;
  /** The active cel's value, for the formula-bar fallback when the
   *  active cel isn't a formula. */
  activeValue: unknown;
}

export const renderToolbar = (i: ToolbarInputs): VNode => {
  const formulaBarText = i.selected
    ? (i.sources[i.selected] !== undefined
        ? `=${i.sources[i.selected]}`
        : displayValue(i.activeValue))
    : "";

  const nameBoxText = !i.selected
    ? "—"
    : i.selectionEnd && i.selectionEnd !== i.selected
      ? `${i.selected}:${i.selectionEnd}`
      : i.selected;

  return el("div", { class: "toolbar" },
    el("span", { class: "name-box" }, nameBoxText),
    el("input", {
      class: "formula-bar",
      type: "text",
      value: formulaBarText,
      // Disable the bar when no cell is selected — keeps the empty
      // anchor case from accepting random typing.
      disabled: !i.selected,
      onFocus:   { dispatch: "sheet:formulaBarFocus" },
      onKeyDown: { dispatch: "sheet:formulaBarKeyDown" },
      onBlur:    { dispatch: "sheet:formulaBarBlur" },
    }),
  );
};
