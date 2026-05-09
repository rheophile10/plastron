import type { Fn, State } from "../../../../plastron/src/index.js";
import { COLS, ROWS, addressOf, parseAddress } from "../domain/address.js";

// ============================================================================
// Selection actions — anchor / extent / drag tracking.
//
// `dragging` is module-scope on purpose: in-progress drag state is
// short-lived UI bookkeeping, not graph data. The document mouseup
// listener wired in main.ts calls stopDragging() to clear it no
// matter where the cursor releases.
// ============================================================================

let dragging = false;

export const stopDragging = (): void => { dragging = false; };

export const mouseDown: Fn = async (...args: unknown[]) => {
  const [state, payload, event] = args as [State, string, MouseEvent | undefined];
  const shift = event?.shiftKey ?? false;
  dragging = true;

  if (shift) {
    // Extend the existing selection to this cell; keep the anchor.
    await (state.fns.get("set") as Fn)(state, "__sheet:selectionEnd", payload);
  } else {
    // Fresh selection — anchor and end collapse to this cell.
    await (state.fns.get("batch") as Fn)(state, [
      ["__sheet:selected",     payload],
      ["__sheet:selectionEnd", payload],
    ]);
  }
};

export const mouseEnter: Fn = async (...args: unknown[]) => {
  if (!dragging) return;
  const [state, payload] = args as [State, string];
  const cur = state.cels.get("__sheet:selectionEnd")?.v;
  if (cur === payload) return;
  await (state.fns.get("set") as Fn)(state, "__sheet:selectionEnd", payload);
};

/** Shift the selection by (dc, dr), clamped to the grid. Both anchor
 *  and extent collapse to the new cell — multi-cell selection
 *  collapses on navigation. */
export const moveSelection: Fn = async (...args: unknown[]) => {
  const [state, payload] = args as [State, { dc?: number; dr?: number }];
  const dc = payload?.dc ?? 0;
  const dr = payload?.dr ?? 0;
  const cur = (state.cels.get("__sheet:selected")?.v as string) ?? "";
  if (!cur) return;
  const pos = parseAddress(cur);
  if (!pos) return;
  const newCol = Math.max(0, Math.min(COLS - 1, pos.col + dc));
  const newRow = Math.max(0, Math.min(ROWS - 1, pos.row + dr));
  const newAddr = addressOf(newCol, newRow);
  if (newAddr === cur) return;
  await (state.fns.get("batch") as Fn)(state, [
    ["__sheet:selected",     newAddr],
    ["__sheet:selectionEnd", newAddr],
  ]);
};
