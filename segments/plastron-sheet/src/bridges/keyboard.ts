import type { Fn, State } from "../../../../plastron/src/index.js";
import { clearSelection, clearCopyMark } from "../actions/clipboard.js";

// ============================================================================
// Keyboard bridge — document-level keydown listener for navigation,
// clear, escape, and type-to-edit. Skipped when an input is already
// focused (the cell editor or the formula bar own their own keydowns).
//
// Dispatches into kernel fns rather than calling actions directly,
// consistent with the philosophy that actions go through the registry.
// ============================================================================

const NAV_KEYS: Record<string, { dc?: number; dr?: number }> = {
  Enter:      { dr: 1 },
  Tab:        { dc: 1 },
  ArrowUp:    { dr: -1 },
  ArrowDown:  { dr: 1 },
  ArrowLeft:  { dc: -1 },
  ArrowRight: { dc: 1 },
};

const editingNow = (): boolean => {
  const ae = document.activeElement;
  return ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement;
};

export const installKeyboardBridge = (state: State): void => {
  const typeIntoSelected = state.fns.get("sheet:typeIntoSelected") as Fn;
  const moveSelection    = state.fns.get("sheet:moveSelection")    as Fn;

  document.addEventListener("keydown", async (event) => {
    if (editingNow()) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    // Escape — cancel the marching-ants copy overlay.
    if (event.key === "Escape") {
      void clearCopyMark(state);
      return;
    }

    // Delete / Backspace — wipe the selected range's contents.
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      await clearSelection(state);
      return;
    }

    // Navigation. Shift reverses Enter/Tab.
    const baseDelta = NAV_KEYS[event.key];
    if (baseDelta) {
      const reverse = event.shiftKey && (event.key === "Enter" || event.key === "Tab");
      const delta = reverse
        ? { dc: -(baseDelta.dc ?? 0), dr: -(baseDelta.dr ?? 0) }
        : baseDelta;
      event.preventDefault();
      await moveSelection(state, delta);
      return;
    }

    // Type-to-edit. Only single-character keys; multi-char keys
    // ("Escape", "F1", …) are ignored.
    if (event.key.length !== 1) return;
    event.preventDefault();
    await typeIntoSelected(state, event.key);
    // After the cycle has fired and the patch cel updated, wait one rAF
    // so the painter has applied — then explicitly focus the new input
    // and put the cursor at end (since we seeded it with the keystroke).
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const input = document.querySelector("input.cell-input");
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });
};
