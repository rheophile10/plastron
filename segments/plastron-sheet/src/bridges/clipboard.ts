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

/** Install the clipboard bridge and return a disposer that removes all
 *  three (copy / cut / paste) document-level listeners. */
export const installClipboardBridge = (state: State): (() => void) => {
  const copyHandler  = (event: ClipboardEvent): void => {
    if (editingNow()) return;
    copySelectionTo(state, event);
  };
  const cutHandler   = (event: ClipboardEvent): void => {
    if (editingNow()) return;
    cutSelectionTo(state, event);
  };
  const pasteHandler = (event: ClipboardEvent): void => {
    if (editingNow()) return;
    void pasteFromClipboard(state, event);
  };

  document.addEventListener("copy",  copyHandler);
  document.addEventListener("cut",   cutHandler);
  document.addEventListener("paste", pasteHandler);

  return () => {
    document.removeEventListener("copy",  copyHandler);
    document.removeEventListener("cut",   cutHandler);
    document.removeEventListener("paste", pasteHandler);
  };
};
