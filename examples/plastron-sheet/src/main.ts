import { createInitialState } from "../../../plastron/src/index.js";
import { installDom } from "../../../segments/plastron-dom/src/index.js";
import type { Fn } from "../../../plastron/src/types/index.js";
import {
  buildSheetSegment,
  copySelectionTo,
  pasteFromClipboard,
  stopDragging,
  clearCopyMark,
} from "./sheet.js";
import { infixFormula } from "./formula.js";

// ========================================================================
// Bootstrap.
//
// 1. Replace the default S-expression formula compiler at fns["f"] with
//    our Excel-style infix one — that slot is unlocked specifically so a
//    host can do this.
// 2. Hydrate the sheet segment.
// 3. Run a full cycle so every formula cel evaluates from scratch.
// 4. Mount via plastron-dom on #root, force the initial paint
//    synchronously so there's no blank-frame flash on load.
// 5. Wire document-level listeners that the cel-graph can't naturally
//    own: mouseup (drag-end no matter where the cursor releases),
//    copy/paste (clipboard plumbing).
// ========================================================================

const state = createInitialState();
const hydrate = state.fns.get("hydrate") as Fn;
const runCycle = state.fns.get("runCycle") as Fn;

// 1. Swap formula compiler.
hydrate(state, [], [new Map([["f", infixFormula]])]);

// 2. Sheet segment.
const sheet = buildSheetSegment();
hydrate(state, [sheet.segment], [sheet.fns]);

// 3. Initial cycle.
await runCycle(state);

// 4. Mount + initial paint.
const handle = installDom(state, {
  roots: { app: { selector: "#root", cel: "sheetTree" } },
});
await runCycle(state);
handle.painter.flushNow();

// 5. Document-level listeners.
//
// mouseup ends a drag-select even if the cursor leaves the grid before
// the user releases — our cell-level mouseup binding wouldn't catch that.
document.addEventListener("mouseup", () => {
  stopDragging();
});

// copy/paste fire on document when no input is focused. Skip our
// handlers when the user is editing a cell — the input element should
// own its own clipboard.
const editingNow = (): boolean => {
  const ae = document.activeElement;
  return ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement;
};

document.addEventListener("copy", (event) => {
  if (editingNow()) return;
  copySelectionTo(state, event);
});

document.addEventListener("paste", (event) => {
  if (editingNow()) return;
  void pasteFromClipboard(state, event);
});

// Document-level keydown handles two distinct cases for a cell that's
// selected but not in edit mode:
//
//   1. Navigation keys (Enter / Tab / Arrow*) move the selection.
//      Excel-style: shift-Enter / shift-Tab reverse direction.
//   2. Printable keystrokes drop into edit mode on the selected cell,
//      seeded with the keystroke (Excel-style "replace" behavior).
//
// When an input is already focused — the cell editor or the formula
// bar — its own onKeyDown handles things; we step out.

const typeIntoSelected = state.fns.get("sheet:typeIntoSelected") as Fn;
const moveSelection    = state.fns.get("sheet:moveSelection")    as Fn;

const NAV_KEYS: Record<string, { dc?: number; dr?: number }> = {
  Enter:      { dr: 1 },
  Tab:        { dc: 1 },
  ArrowUp:    { dr: -1 },
  ArrowDown:  { dr: 1 },
  ArrowLeft:  { dc: -1 },
  ArrowRight: { dc: 1 },
};

document.addEventListener("keydown", async (event) => {
  if (editingNow()) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  // 1. Escape — cancel the marching-ants copy overlay (Excel
  // behavior). Other Escape uses (cancelling cell edit) are handled
  // inside the input's own keydown.
  if (event.key === "Escape") {
    void clearCopyMark(state);
    return;
  }

  // 2. Navigation
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

  // 3. Type-to-edit. Only single-character keys; multi-char keys
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

// Position the marching-ants marquee after each paint, by measuring
// the actual DOM cells (the table's column widths can drift from CSS
// pixel values, so computing the rectangle from constants is brittle).
// MutationObserver fires whenever the painter mutates the table — far
// cheaper than running on every animation frame, and exact.
const positionMarquee = (): void => {
  const marquee = document.querySelector(".copy-marquee") as HTMLElement | null;
  if (!marquee) return;
  const start = marquee.dataset.start;
  const end   = marquee.dataset.end;
  if (!start) return;
  const wrapper = document.querySelector(".grid-wrapper");
  if (!wrapper) return;

  const cellEl = (addr: string): HTMLElement | null => {
    // Find the <td> by walking the table structure: each row has
    // header + cells, so a 0-indexed col `c` and row `r` lands at
    // tbody>tr[r]>td[c+1] (the +1 skips the row header <th>).
    const m = /^([A-Z]+)(\d+)$/.exec(addr);
    if (!m) return null;
    const col = m[1]!.charCodeAt(0) - 65;
    const row = parseInt(m[2]!, 10) - 1;
    const tr = wrapper.querySelectorAll("tbody tr")[row];
    if (!tr) return null;
    return tr.children[col + 1] as HTMLElement;
  };

  const a = cellEl(start);
  const b = cellEl(end || start);
  if (!a || !b) return;

  const wrap = wrapper.getBoundingClientRect();
  const ar = a.getBoundingClientRect();
  const br = b.getBoundingClientRect();

  const left   = Math.min(ar.left, br.left) - wrap.left;
  const top    = Math.min(ar.top,  br.top)  - wrap.top;
  const right  = Math.max(ar.right,  br.right);
  const bottom = Math.max(ar.bottom, br.bottom);
  const width  = right  - Math.min(ar.left, br.left);
  const height = bottom - Math.min(ar.top,  br.top);

  marquee.style.left   = `${left}px`;
  marquee.style.top    = `${top}px`;
  marquee.style.width  = `${width}px`;
  marquee.style.height = `${height}px`;
};

const root = document.querySelector("#root");
if (root) {
  // Re-position whenever the painter has mutated the DOM. Cheap (most
  // mutations don't include the marquee, and the early-out skips the
  // measurement when the marquee isn't present).
  new MutationObserver(positionMarquee).observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-start", "data-end"],
  });
  // Catch the first time it appears, in case the observer fires before
  // we have time to set up.
  positionMarquee();
}

console.log("[plastron-sheet] mounted");
(globalThis as { __plastronState?: unknown }).__plastronState = state;
