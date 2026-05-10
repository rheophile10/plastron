import { createInitialState } from "../../../plastron/src/index.js";
import { installDom } from "../../../segments/plastron-dom/src/index.js";
import { installSheet } from "../../../segments/plastron-sheet/src/index.js";
import type { Fn } from "../../../plastron/src/index.js";
import "../../../segments/plastron-sheet/src/styles.css";

// ============================================================================
// Bootstrap.
//
//   1. Install the plastron-sheet segment — replaces the kernel's formula
//      compiler with the Excel-style infix one, hydrates the sheet's
//      cels + lambdas, and wires document-level bridges (mouseup,
//      keyboard, clipboard, marquee).
//   2. Run a full cycle so every formula evaluates from scratch.
//   3. Mount via plastron-dom on #root, force the initial paint
//      synchronously so there's no blank-frame flash.
// ============================================================================

const state = createInitialState();
const runCycle = state.fns.get("runCycle") as Fn;

const sheet = installSheet(state);
await runCycle(state);

const handle = installDom(state, {
  roots: { app: { selector: "#root", cel: sheet.treeCel } },
});
await runCycle(state);
handle.channel.drain();

console.log("[plastron-sheet] mounted");
(globalThis as { __plastronState?: unknown }).__plastronState = state;
