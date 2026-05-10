import type { State } from "../../../../plastron/src/index.js";
import {
  copySelectionTo, cutSelectionTo, pasteFromClipboard,
} from "../actions/clipboard.js";

// ============================================================================
// Clipboard bridge — document-level copy/cut/paste listeners. Skipped
// when an input is focused (the input owns its own clipboard).
// ============================================================================

const editingNow = (): boolean => {
  const ae = document.activeElement;
  return ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement;
};

export const installClipboardBridge = (state: State): void => {
  document.addEventListener("copy", (event) => {
    if (editingNow()) return;
    copySelectionTo(state, event);
  });
  document.addEventListener("cut", (event) => {
    if (editingNow()) return;
    cutSelectionTo(state, event);
  });
  document.addEventListener("paste", (event) => {
    if (editingNow()) return;
    void pasteFromClipboard(state, event);
  });
};
