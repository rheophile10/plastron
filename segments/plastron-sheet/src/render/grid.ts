import { cx, displayValue, el, onClick, when, type VNode } from "../../../plastron-dom/src/index.js";
import { COLS, ROWS, addressOf, colLetter, rectFor } from "../domain/address.js";
import type { CopyMark } from "../actions/clipboard.js";

// ============================================================================
// Grid — column header row, row headers, cell <td>s, and the marching-
// ants overlay placeholder element (positioned by bridges/marquee.ts).
//
// `cellValues` is a function so the renderer doesn't have to know how
// inputs are shaped; the composer wires it up. Same trick for `inputs`
// — only renderToolbar / renderGrid know what they each need.
// ============================================================================

export interface GridInputs {
  selected: string;
  selectionEnd: string;
  editing: string;
  editSeed: string;
  sources: Record<string, string>;
  copyMark: CopyMark | null;
  /** Returns the cel value for an address. */
  cellValue: (addr: string) => unknown;
}

export const renderGrid = (i: GridInputs): VNode => {
  const rect = i.selected ? rectFor(i.selected, i.selectionEnd || i.selected) : null;
  const inSelection = (col: number, row: number): boolean =>
    rect !== null && col >= rect.c0 && col <= rect.c1 && row >= rect.r0 && row <= rect.r1;

  const headerCells: VNode[] = [el("th", { class: "corner" }, "")];
  for (let c = 0; c < COLS; c++) {
    headerCells.push(el("th", { class: "col-header" }, colLetter(c)));
  }

  const bodyRows: VNode[] = [];
  for (let r = 0; r < ROWS; r++) {
    const cells: VNode[] = [el("th", { class: "row-header" }, String(r + 1))];
    for (let c = 0; c < COLS; c++) {
      const addr = addressOf(c, r);
      const isAnchor   = i.selected === addr;
      const isInRange  = inSelection(c, r);
      const isEditing  = i.editing === addr;
      const value      = i.cellValue(addr);
      const hasFormula = i.sources[addr] !== undefined;

      const classes = cx(
        "cell",
        isAnchor && "anchor",
        isInRange && !isAnchor && "range",
        isEditing && "editing",
        hasFormula && "formula",
        typeof value === "number" && "numeric",
      );

      let inner: VNode | string;
      if (isEditing) {
        // editSeed wins if non-empty (type-to-edit replaces content);
        // otherwise fall back to the cell's current content (double-
        // click preserves it for editing).
        const seed = i.editSeed !== ""
          ? i.editSeed
          : (hasFormula ? `=${i.sources[addr]}` : displayValue(value));
        inner = el("input", {
          class: "cell-input",
          type: "text",
          value: seed,
          onKeyDown: onClick("sheet:editKeyDown", addr),
          onBlur:    onClick("sheet:editBlur",    addr),
        });
      } else {
        inner = displayValue(value);
      }

      cells.push(el("td", {
        class: classes,
        onMouseDown:  onClick("sheet:mouseDown",  addr),
        onMouseEnter: onClick("sheet:mouseEnter", addr),
        onDblClick:   onClick("sheet:edit",       addr),
      }, inner as string));
    }
    bodyRows.push(el("tr", null, ...cells));
  }

  // The marching-ants overlay's position is set imperatively in
  // bridges/marquee.ts (it measures actual cell rects so it stays
  // accurate even if column widths drift from the CSS pixel values).
  // We just emit the element with `data-start` / `data-end` so the
  // helper knows which cells to measure.
  return el("div", { class: "grid-wrapper" },
    el("table", { class: "grid" },
      el("thead", null, el("tr", null, ...headerCells)),
      el("tbody", null, ...bodyRows),
    ),
    when(i.copyMark, () => el("div", {
      class: "copy-marquee",
      "data-start": i.copyMark!.start,
      "data-end":   i.copyMark!.end,
    })),
  );
};
