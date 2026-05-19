import type { CelTriple, DehydratedCel, Fn, State } from "../../../../plastron/src/index.js";
import { classifyInput } from "../domain/parse.js";
import { moveSelection } from "./selection.js";

/** Convert the output of `classifyInput` into a CelTriple suitable for
 *  setCelBatch. Either path explicitly clears the other compute fields
 *  so a formula→value or value→formula transition fully replaces the
 *  cel's role atomically. */
const dcToTriple = (dc: DehydratedCel): CelTriple =>
  dc.f !== undefined
    ? { f: dc.f, l: null }
    : { v: dc.v ?? "", f: null, l: null };

// ============================================================================
// Cell-edit actions: enter/leave edit mode, commit, type-to-edit, plus
// the formula bar handlers.
//
// Two pieces of module-level state live here, both single-event-loop
// transients (philosophy: the cursor is in cels; in-flight bookkeeping
// is allowed at module scope):
//
//   formulaBarTarget       — which cel the formula bar is editing,
//                            captured on focus so a click-elsewhere
//                            mid-edit still commits to the originally-
//                            edited cel.
//   cancelFormulaBarBlur   — set by Escape so the upcoming blur skips
//                            its commit.
// ============================================================================

export const edit: Fn = async (...args: unknown[]) => {
  const [state, payload] = args as [State, string];
  await (state.fns.get("batch") as Fn)(state, [
    ["__sheet:selected",     payload],
    ["__sheet:selectionEnd", payload],
    ["__sheet:editing",      payload],
    ["__sheet:editSeed",     ""],
  ]);
};

export const cancelEdit = async (state: State): Promise<void> => {
  await (state.fns.get("batch") as Fn)(state, [
    ["__sheet:editing",  ""],
    ["__sheet:editSeed", ""],
  ]);
};

/** Enter edit mode on the currently selected cell, seeded with the
 *  given character (typing on a selected cell replaces its content). */
export const typeIntoSelected: Fn = async (...args: unknown[]) => {
  const [state, payload] = args as [State, string];
  const selected = (state.cels.get("__sheet:selected")?.v as string) ?? "";
  if (!selected) return;
  await (state.fns.get("batch") as Fn)(state, [
    ["__sheet:editing",  selected],
    ["__sheet:editSeed", payload],
  ]);
};

const commitFromInput = async (state: State, addr: string, raw: string): Promise<void> => {
  const trimmed = raw.trim();
  const setCelBatch = state.fns.get("setCelBatch") as Fn;

  const sources = (state.cels.get("__sheet:sources")?.v as Record<string, string>) ?? {};
  const nextSources: Record<string, string> = { ...sources };
  const dc = classifyInput(addr, trimmed, nextSources);

  // One atomic write: cel role change + sources update + clear edit
  // state. setCelBatch fires a single cascade over the union of all
  // affected keys — was previously hydrate → runCycle → set → batch
  // (3+ cascades) per commit. Cookbook §3b + §13.
  await setCelBatch(state, {
    [addr]:              dcToTriple(dc),
    "__sheet:sources":   { v: nextSources },
    "__sheet:editing":   { v: "" },
    "__sheet:editSeed":  { v: "" },
  });
};

export const editKeyDown: Fn = async (...args: unknown[]) => {
  const [state, payload, event] = args as [State, string, KeyboardEvent];
  const target = event?.target as HTMLInputElement | null;
  if (!target) return;
  if (event.key === "Enter") {
    event.preventDefault?.();
    await commitFromInput(state, payload, target.value);
    await moveSelection(state, event.shiftKey ? { dr: -1 } : { dr: 1 });
  } else if (event.key === "Tab") {
    event.preventDefault?.();
    await commitFromInput(state, payload, target.value);
    await moveSelection(state, event.shiftKey ? { dc: -1 } : { dc: 1 });
  } else if (event.key === "Escape") {
    event.preventDefault?.();
    await cancelEdit(state);
  }
};

export const editBlur: Fn = async (...args: unknown[]) => {
  const [state, payload, event] = args as [State, string, FocusEvent];
  const target = event?.target as HTMLInputElement | null;
  if (!target) return;
  await commitFromInput(state, payload, target.value);
};

// ─── formula bar ─────────────────────────────────────────────────────

let formulaBarTarget = "";
let cancelFormulaBarBlur = false;

export const formulaBarFocus: Fn = (state: State) => {
  formulaBarTarget = (state.cels.get("__sheet:selected")?.v as string) ?? "";
  cancelFormulaBarBlur = false;
};

export const formulaBarKeyDown: Fn = async (...args: unknown[]) => {
  const [state, , event] = args as [State, unknown, KeyboardEvent];
  const target = event?.target as HTMLInputElement | null;
  if (!target) return;
  if (event.key === "Enter") {
    event.preventDefault?.();
    if (formulaBarTarget) {
      await commitFromInput(state, formulaBarTarget, target.value);
    }
    cancelFormulaBarBlur = true;
    target.blur();
  } else if (event.key === "Escape") {
    event.preventDefault?.();
    cancelFormulaBarBlur = true;
    target.blur();
  }
};

export const formulaBarBlur: Fn = async (...args: unknown[]) => {
  const [state, , event] = args as [State, unknown, FocusEvent];
  const target = event?.target as HTMLInputElement | null;
  if (cancelFormulaBarBlur) {
    cancelFormulaBarBlur = false;
    formulaBarTarget = "";
    return;
  }
  if (!target || !formulaBarTarget) {
    formulaBarTarget = "";
    return;
  }
  const captured = formulaBarTarget;
  formulaBarTarget = "";
  await commitFromInput(state, captured, target.value);
};
