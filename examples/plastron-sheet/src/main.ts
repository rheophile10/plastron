import { createInitialState } from "../../../plastron/src/index.js";
import { installDom } from "../../../segments/plastron-dom/src/index.js";
import type { Fn } from "../../../plastron/src/index.js";
import { infixFormula } from "./formula.js";
import { buildSheetSegment } from "./segments/sheet.js";
import { stopDragging } from "./actions/selection.js";
import { installKeyboardBridge } from "./bridges/keyboard.js";
import { installClipboardBridge } from "./bridges/clipboard.js";
import { installMarqueeBridge } from "./bridges/marquee.js";

// ============================================================================
// Bootstrap.
//
//   1. Replace the default S-expression formula compiler at fns["f"] with
//      the Excel-style infix one.
//   2. Hydrate the sheet segment.
//   3. Run a full cycle so every formula evaluates from scratch.
//   4. Mount via plastron-dom on #root, force the initial paint
//      synchronously so there's no blank-frame flash.
//   5. Wire document-level bridges (mouseup → drag-end, keyboard,
//      clipboard, marquee positioning) that the cel-graph can't
//      naturally own.
// ============================================================================

const state = createInitialState();
const hydrate = state.fns.get("hydrate") as Fn;
const runCycle = state.fns.get("runCycle") as Fn;

hydrate(state, [], [new Map([["f", infixFormula]])]);

const sheet = buildSheetSegment();
hydrate(state, [sheet.segment], [sheet.fns]);

await runCycle(state);

const handle = installDom(state, {
  roots: { app: { selector: "#root", cel: "appTree" } },
});
await runCycle(state);
handle.channel.drain();

document.addEventListener("mouseup", stopDragging);
installKeyboardBridge(state);
installClipboardBridge(state);
installMarqueeBridge();

console.log("[plastron-sheet] mounted");
(globalThis as { __plastronState?: unknown }).__plastronState = state;
