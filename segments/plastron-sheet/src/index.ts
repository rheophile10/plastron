import type { Cel, Fn, SegmentManifest, State } from "../../../plastron/src/index.js";
import { PLASTRON_DOM_SEGMENT } from "../../plastron-dom/src/index.js";
import { infixFormula } from "./formula.js";
import { buildSheetSegment } from "./segments/sheet.js";
import { buildFnMathSegment } from "./segments/fnMath.js";
import { buildFnTextSegment }  from "./segments/fnText.js";
import { buildFnLogicSegment } from "./segments/fnLogic.js";
import { buildFnStatsSegment } from "./segments/fnStats.js";
import { buildFnDateSegment }  from "./segments/fnDate.js";
import { stopDragging } from "./actions/selection.js";
import { installKeyboardBridge } from "./bridges/keyboard.js";
import { installClipboardBridge } from "./bridges/clipboard.js";
import { installMarqueeBridge } from "./bridges/marquee.js";
import { SHEET_CONTROLS_SEGMENT } from "./domain/parse.js";

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

/** Identifier for the workbook's "anchor" segment — the controls
 *  segment that carries the render tree, workbook-level state, and
 *  the bridge-disposer sentinel. Hosts that want to tear down the
 *  whole plastron-sheet bundle should call `flushSheets(state)` (or
 *  `flush(state, SHEET_CONTROLS_SEGMENT)` followed by flushing each
 *  `sheet:<Name>` user segment — the sentinel's `_dispose` does the
 *  user-sheet sweep automatically). */
export const PLASTRON_SHEET_SEGMENT = SHEET_CONTROLS_SEGMENT;

/** Manifest for the plastron-sheet **controls** segment — workbook-
 *  level state, the render tree, every action lambda, and the
 *  bridge-disposer sentinel. Per-user-sheet manifests are produced by
 *  `userSheetManifestFor(name)` and shipped alongside the cells. */
export const plastronSheetControlsManifest: SegmentManifest = {
  segment: SHEET_CONTROLS_SEGMENT,
  version: "1.0.0",
  description:
    "Workbook controls for plastron-sheet — render tree, selection / " +
    "edit / clipboard state, the activeSheet cel, and the bridge-" +
    "disposer sentinel. User cells live in sibling sheet:<Name> segments.",
  dependsOn: [
    { segment: PLASTRON_DOM_SEGMENT, required: false },
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
    celSegments: [SHEET_CONTROLS_SEGMENT],
  },
};

/** Manifest for one user sheet's cells. Each user sheet gets its own
 *  segment so flush / dehydrate / replace happen at sheet granularity.
 *  No lambdas — render fns and action handlers live in the controls
 *  segment alongside the appTree they feed. */
export const userSheetManifestFor = (name: string): SegmentManifest => ({
  segment: `sheet:${name}`,
  version: "1.0.0",
  description: `User cell segment for sheet "${name}".`,
  provides: {
    celSegments: [`sheet:${name}`],
  },
});

/** Back-compat: the manifest the segment used to ship as one piece.
 *  New code should use `plastronSheetControlsManifest` +
 *  `userSheetManifestFor(name)`. */
export const plastronSheetManifest = plastronSheetControlsManifest;

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
  /** Tear-down hook for the document-level bridges. Calls every bridge
   *  disposer registered during `installSheet`. Also invoked by the
   *  sentinel cel's `_dispose` when `flush(state, "sheet")` fires, so
   *  hosts get the same cleanup whether they call `handle.dispose()`
   *  manually or flush the segment.
   *
   *  Note (per decision 2 in notes/todo.md): the kernel's `f` slot is
   *  NOT restored — the sheet's formula compiler swap is treated as
   *  effectively permanent for a session. Re-installing a different
   *  formula compiler is the host's responsibility after flush. */
  dispose: () => void;
}

/** Sentinel cel key. The kernel's `flush(state, "sheet")` walks every
 *  cel with `segment === "sheet"` and fires `_dispose` on each — this
 *  one carries the bridge-disposer closure. */
const SHEET_SENTINEL_KEY = "__sheet:sentinel" as const;

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

  // 2) Build all sheet segments (controls + one per user sheet + the
  //    math function library) and hydrate them in one call. The
  //    lambdas for the render tree + action handlers travel with the
  //    controls manifest; user-sheet segments and the fn library are
  //    lambda-free (their cels carry their fns in `v`).
  //
  //    Each user sheet derives its own manifest from the segment key
  //    (`sheet:<Name>`), so per-sheet flush / dehydrate hits exactly
  //    the right cells. See notes/todo.md Phase 3 §3 for the design.
  const sheet = buildSheetSegment();
  const userSheetSegments = sheet.userSheets.map((seg) => {
    const name = seg.key.startsWith("sheet:") ? seg.key.slice("sheet:".length) : seg.key;
    return { ...seg, manifest: userSheetManifestFor(name) };
  });
  const fnLibraries = [
    buildFnMathSegment(),
    buildFnTextSegment(),
    buildFnLogicSegment(),
    buildFnStatsSegment(),
    buildFnDateSegment(),
  ];
  hydrate(
    state,
    [
      { ...sheet.controls, manifest: plastronSheetControlsManifest },
      ...userSheetSegments,
      ...fnLibraries,
    ],
    [sheet.fns],
  );

  // 3) Wire document-level bridges unless the host opts out. Each
  //    bridge installer returns its own disposer; we collect them
  //    into one closure for the sentinel cel.
  const disposers: Array<() => void> = [];
  if (installBridges && typeof document !== "undefined") {
    document.addEventListener("mouseup", stopDragging);
    disposers.push(() => document.removeEventListener("mouseup", stopDragging));
    disposers.push(installKeyboardBridge(state));
    disposers.push(installClipboardBridge(state));
    disposers.push(installMarqueeBridge());
  }

  // Idempotent: `dispose` only runs the disposers once even if both
  // `handle.dispose()` and the sentinel `_dispose` fire (e.g. caller
  // disposes manually then later flushes).
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const d of disposers) {
      try { d(); } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[plastron-sheet] bridge dispose failed:", err);
      }
    }
    disposers.length = 0;

    // Sweep user-sheet segments. flush() is per-segment in the kernel,
    // so we walk state.segments to find every `sheet:<Name>` other
    // than the controls segment and tear it down. This way callers
    // need only `flush(state, SHEET_CONTROLS_SEGMENT)` for a full
    // workbook teardown — no second-level bookkeeping required.
    const flush = state.fns.get("flush") as Fn;
    const userSheetKeys: string[] = [];
    for (const key of state.segments.keys()) {
      if (typeof key !== "string") continue;
      if (key === SHEET_CONTROLS_SEGMENT) continue;
      if (key.startsWith("sheet:")) userSheetKeys.push(key);
    }
    for (const key of userSheetKeys) {
      try { flush(state, key); } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[plastron-sheet] flush "${key}" failed:`, err);
      }
    }
  };

  // 4) Sentinel cel — lives in the CONTROLS segment, so
  //    `flush(state, SHEET_CONTROLS_SEGMENT)` fires this `_dispose`,
  //    which tears down listeners AND sweeps user-sheet segments.
  const sentinel: Cel = {
    key: SHEET_SENTINEL_KEY,
    v: null,
    segment: SHEET_CONTROLS_SEGMENT,
    _dispose: dispose,
  };
  state.cels.set(sentinel.key, sentinel);

  return { treeCel: "appTree", dispose };
};

// Public exports for hosts that want to drop one of the pre-baked
// pieces and replace it with their own (e.g. swap the renderer, plug
// in a different formula compiler).
export { infixFormula } from "./formula.js";
export { buildSheetSegment } from "./segments/sheet.js";
export {
  buildFnMathSegment, fnMathManifest, SHEET_FN_MATH_SEGMENT,
} from "./segments/fnMath.js";
export { renderApp } from "./render/app.js";
export { renderGrid } from "./render/grid.js";
export { renderToolbar } from "./render/toolbar.js";
export {
  COLS, ROWS, addressOf, colLetter, parseAddress, allAddresses, rectFor,
} from "./domain/address.js";
export type { Rect } from "./domain/address.js";
export {
  classifyInput,
  SHEET_SEGMENT, SHEET_CONTROLS_SEGMENT, DEFAULT_SHEET_NAME, sheetSegmentFor,
} from "./domain/parse.js";
export { displayValue } from "../../plastron-dom/src/index.js";
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
