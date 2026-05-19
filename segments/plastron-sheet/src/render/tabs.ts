import { el, cx, onSet, type VNode } from "../../../plastron-dom/src/index.js";

// ============================================================================
// Tab bar renderer — one button per user sheet, with the active one
// highlighted. Click writes the sheet's name into __sheet:activeSheet,
// which downstream cascades through the grid/toolbar render.
//
// Pure data-driven: the tab bar IS a render lambda over
// `__sheet:userSheets` + `__sheet:activeSheet`. Adding/renaming/hiding
// a sheet is just a write to those cels. No imperative "register a tab"
// API needed.
//
// Lives under render/ today, not as its own UI segment, to keep Step 3
// scope tight. Phase 3 §5 promotes this to `sheet:ui:tabs` with its
// own manifest and replace-by-flush semantics.
// ============================================================================

export interface TabsInput {
  /** Display order of user sheets. Read from `__sheet:userSheets`. */
  sheets: ReadonlyArray<string>;
  /** Currently active sheet name. Read from `__sheet:activeSheet`. */
  active: string;
}

export const renderTabs = ({ sheets, active }: TabsInput): VNode =>
  el(
    "div",
    { class: "sheet-tabs", role: "tablist" },
    ...sheets.map((name) =>
      el(
        "button",
        {
          type: "button",
          class: cx("sheet-tab", name === active && "active"),
          role: "tab",
          "aria-selected": name === active ? "true" : "false",
          onClick: onSet("__sheet:activeSheet", name),
        },
        name,
      ),
    ),
  );
