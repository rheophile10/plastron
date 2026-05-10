import type { Fn, SegmentManifest, State } from "../../../plastron/src/index.js";
import { infixFormula } from "./formula.js";
import { buildSheetSegment } from "./segments/sheet.js";
import { stopDragging } from "./actions/selection.js";
import { installKeyboardBridge } from "./bridges/keyboard.js";
import { installClipboardBridge } from "./bridges/clipboard.js";
import { installMarqueeBridge } from "./bridges/marquee.js";
import { SHEET_SEGMENT } from "./domain/parse.js";

// ============================================================================
// segment: plastron-sheet
//
// A pre-wired spreadsheet segment. installSheet:
//
//   1. Replaces the kernel's default S-expression formula compiler at
//      fns key "f" with the Excel-style infix one — that slot is left
//      unlocked specifically so segments like this can swap languages.
//   2. Hydrates the sheet's control cels (`__sheet:selected`, etc.),
//      every visible-cell cel (A1…) seeded from the demo ledger, and
//      the `appTree` render cel that composes them into a vnode tree.
//   3. Registers the action lambdas (`sheet:edit`, `sheet:moveSelection`,
//      …) that event handlers in the rendered vnode dispatch into.
//   4. Wires document-level bridges (mouseup → drag-end, keyboard
//      navigation / type-to-edit, copy / cut / paste, marquee
//      positioning) — the cel-graph can't naturally own these.
//
// The host is responsible for:
//
//   • Mounting the `appTree` cel into a DOM root via `installDom`. The
//     handle returned by installSheet exposes the tree cel key under
//     `treeCel` so the host can pass it to installDom.
//   • Calling `runCycle(state)` after installSheet so the initial
//     formulas evaluate and the first vnode tree materializes.
//
// Behavior is identical to the original `examples/plastron-sheet/`
// demo — this segment is the lifted, packaged form.
// ============================================================================

export const PLASTRON_SHEET_SEGMENT = SHEET_SEGMENT;

/** Manifest for the plastron-sheet segment. The render lambda and
 *  every action handler are listed under `provides.lambdas`. The
 *  segment owns its own cel segment (`sheet`) and depends on
 *  `plastron-dom` only insofar as the rendered tree contains VNodes —
 *  the dependency is on the vnode shape, not on installDom having run.
 *  We declare it as a soft dependency so a host using a different
 *  painter (or no painter at all, e.g. snapshot tests) can still
 *  hydrate the sheet. */
export const plastronSheetManifest: SegmentManifest = {
  segment: PLASTRON_SHEET_SEGMENT,
  version: "1.0.0",
  description:
    "Excel-style spreadsheet — per-cell cels, infix formulas, selection / edit / clipboard.",
  dependsOn: [
    { segment: "plastronDom", required: false },
  ],
  provides: {
    lambdas: [
      "f",
      "sheet:render",
      "sheet:mouseDown",
      "sheet:mouseEnter",
      "sheet:edit",
      "sheet:editKeyDown",
      "sheet:editBlur",
      "sheet:typeIntoSelected",
      "sheet:moveSelection",
      "sheet:formulaBarFocus",
      "sheet:formulaBarKeyDown",
      "sheet:formulaBarBlur",
    ],
    schemas: [],
    celSegments: [PLASTRON_SHEET_SEGMENT],
  },
};

export interface InstallSheetOptions {
  /** Wire the document-level keyboard / clipboard / marquee / mouseup
   *  bridges. Default true. Set false if the host wants to install
   *  those itself, or in non-browser environments where `document`
   *  doesn't exist. */
  installBridges?: boolean;
}

export interface SheetHandle {
  /** Cel key for the tree the renderer writes into. Pass to installDom
   *  as the cel for whichever root will mount the sheet. */
  treeCel: string;
  /** Tear-down hook for the document-level bridges. Removes the
   *  mouseup listener installed by installSheet. The keyboard /
   *  clipboard bridges register their own document listeners that this
   *  hook does NOT remove (they capture state, not external resources;
   *  flushing the sheet segment makes them no-op since their action
   *  lookups via state.fns will return undefined). */
  dispose: () => void;
}

/** Install the plastron-sheet segment on an existing State. Replaces
 *  the kernel's formula compiler, hydrates the sheet's cels +
 *  lambdas, and (by default) wires document-level event bridges.
 *  Caller is responsible for mounting `treeCel` via installDom and
 *  for calling runCycle to do the first paint. */
export const installSheet = (
  state: State,
  options: InstallSheetOptions = {},
): SheetHandle => {
  const installBridges = options.installBridges ?? true;
  const hydrate = state.fns.get("hydrate") as Fn;

  // 1) Swap the formula compiler (no segment, just a lambda registry
  //    update). The kernel's `f` slot is intentionally unlocked.
  hydrate(state, [], [new Map([["f", infixFormula]])]);

  // 2) Build the sheet segment (cels + lambdas) and hydrate with the
  //    manifest attached.
  const sheet = buildSheetSegment();
  hydrate(
    state,
    [{ ...sheet.segment, manifest: plastronSheetManifest }],
    [sheet.fns],
  );

  // 3) Wire document-level bridges unless the host opts out.
  let mouseUpListener: ((e: MouseEvent) => void) | null = null;
  if (installBridges && typeof document !== "undefined") {
    mouseUpListener = stopDragging;
    document.addEventListener("mouseup", mouseUpListener);
    installKeyboardBridge(state);
    installClipboardBridge(state);
    installMarqueeBridge();
  }

  return {
    treeCel: "appTree",
    dispose: () => {
      if (mouseUpListener) {
        document.removeEventListener("mouseup", mouseUpListener);
        mouseUpListener = null;
      }
    },
  };
};

// Public exports for hosts that want to drop one of the pre-baked
// pieces and replace it with their own (e.g. swap the renderer, plug
// in a different formula compiler).
export { infixFormula } from "./formula.js";
export { buildSheetSegment } from "./segments/sheet.js";
export { renderApp } from "./render/app.js";
export { renderGrid } from "./render/grid.js";
export { renderToolbar } from "./render/toolbar.js";
export {
  COLS, ROWS, addressOf, colLetter, parseAddress, allAddresses, rectFor,
} from "./domain/address.js";
export type { Rect } from "./domain/address.js";
export {
  classifyInput, displayValue, SHEET_SEGMENT,
} from "./domain/parse.js";
export { buildTSV, parseTSV } from "./domain/tsv.js";
export {
  edit, editKeyDown, editBlur, typeIntoSelected,
  formulaBarFocus, formulaBarKeyDown, formulaBarBlur, cancelEdit,
} from "./actions/cell.js";
export {
  mouseDown, mouseEnter, moveSelection, stopDragging,
} from "./actions/selection.js";
export {
  copySelectionTo, cutSelectionTo, pasteFromClipboard,
  clearSelection, clearCopyMark,
} from "./actions/clipboard.js";
export type { CopyMark } from "./actions/clipboard.js";
export { installKeyboardBridge } from "./bridges/keyboard.js";
export { installClipboardBridge } from "./bridges/clipboard.js";
export { installMarqueeBridge } from "./bridges/marquee.js";
