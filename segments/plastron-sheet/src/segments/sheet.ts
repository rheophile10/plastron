import type {
  DehydratedCel, Fn, LambdaKey, Segment,
} from "../../../../plastron/src/index.js";
import { allAddresses } from "../domain/address.js";
import {
  SHEET_SEGMENT, SHEET_CONTROLS_SEGMENT, DEFAULT_SHEET_NAME,
} from "../domain/parse.js";
import { renderApp } from "../render/app.js";
import { mouseDown, mouseEnter, moveSelection } from "../actions/selection.js";
import {
  edit, editKeyDown, editBlur, typeIntoSelected,
  formulaBarFocus, formulaBarKeyDown, formulaBarBlur,
} from "../actions/cell.js";

// ============================================================================
// Sheet segment factory — builds the sheet's cels (control cels,
// per-cell cels seeded from SEED, and the appTree render cel) plus
// the lambda registry that hydrate installs alongside.
//
// The renderer is just one composed lambda registered as sheet:render;
// the appTree cel reads every value cel as an input so changes
// propagate through the cascade.
// ============================================================================

// Pre-filled sheet — values + formulas for a one-glance demo on first
// load.
const SEED: Record<string, { v?: unknown; f?: string }> = {
  A1: { v: "Item" },        B1: { v: "Qty" },   C1: { v: "Price" }, D1: { v: "Total" },
  A2: { v: "Bone, ox" },    B2: { v: 12 },      C2: { v: 4 },       D2: { f: "B2*C2" },
  A3: { v: "Plastron" },    B3: { v: 3 },       C3: { v: 17 },      D3: { f: "B3*C3" },
  A4: { v: "Charcoal" },    B4: { v: 30 },      C4: { v: 0.5 },     D4: { f: "B4*C4" },
  A5: { v: "Bronze pin" },  B5: { v: 8 },       C5: { v: 2.25 },    D5: { f: "B5*C5" },
  // Subtotal / tax / grand total — exercise the math function library
  // (sheet:fn:math) hydrated alongside the sheet. SUM/ROUND demoed.
  A7: { v: "Subtotal" },                                              D7: { f: "SUM(D2:D5)" },
  A8: { v: "Tax (10%)" },                                             D8: { f: "ROUND(D7*0.1, 2)" },
  A9: { v: "Grand total" },                                           D9: { f: "D7+D8" },
  // Row-level stats sidebar — MIN/MAX/AVG/COUNT over the price column.
  F1: { v: "Stats" },
  F2: { v: "min price" },   G2: { f: "MIN(C2:C5)" },
  F3: { v: "max price" },   G3: { f: "MAX(C2:C5)" },
  F4: { v: "avg price" },   G4: { f: "ROUND(AVG(C2:C5), 2)" },
  F5: { v: "rows" },        G5: { f: "COUNT(B2:B5)" },
};

const collectInitialSources = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [addr, seed] of Object.entries(SEED)) {
    if (seed.f !== undefined) out[addr] = seed.f;
  }
  return out;
};

export interface BuiltSheetSegments {
  /** Workbook-level cels: __sheet:* control cels + appTree render +
   *  (later) activeSheet + sentinel. Lives at segment="sheet:controls"
   *  and persists across user-sheet add/remove. */
  controls: Segment;
  /** A single user sheet's cell cels. Lives at segment="sheet:Sheet1"
   *  (default). Phase 3 step 3 generalizes this to one segment per
   *  user sheet. */
  userSheet: Segment;
  /** Lambdas referenced by the segments above. Hydrate registers
   *  these into state.fns alongside the cels. */
  fns: Map<LambdaKey, Fn>;
}

export const buildSheetSegment = (): BuiltSheetSegments => {
  // ── Controls segment: workbook-level state + the render tree ────────────
  const controlCels: DehydratedCel[] = [
    { key: "__sheet:selected",     v: "",                          segment: SHEET_CONTROLS_SEGMENT },
    { key: "__sheet:selectionEnd", v: "",                          segment: SHEET_CONTROLS_SEGMENT },
    { key: "__sheet:editing",      v: "",                          segment: SHEET_CONTROLS_SEGMENT },
    { key: "__sheet:editSeed",     v: "",                          segment: SHEET_CONTROLS_SEGMENT },
    { key: "__sheet:sources",      v: collectInitialSources(),     segment: SHEET_CONTROLS_SEGMENT },
    { key: "__sheet:copyMark",     v: null,                        segment: SHEET_CONTROLS_SEGMENT },
    // Phase 3 foundation: the active user sheet. Multi-sheet step
    // adds tabs that write to this cel; today it's a constant
    // pointing at the single user sheet.
    { key: "__sheet:activeSheet",  v: DEFAULT_SHEET_NAME,          segment: SHEET_CONTROLS_SEGMENT },
  ];

  // ── User-sheet segment: the cell cels A1..H12 ───────────────────────────
  const userCels: DehydratedCel[] = [];
  for (const addr of allAddresses()) {
    const seed = SEED[addr];
    if (seed?.f !== undefined) {
      userCels.push({ key: addr, f: seed.f, segment: SHEET_SEGMENT });
    } else {
      userCels.push({ key: addr, v: seed?.v ?? "", segment: SHEET_SEGMENT });
    }
  }

  // ── appTree render cel lives in CONTROLS (it composes per-sheet
  //    cells but is itself workbook-scoped — there's only one). The
  //    inputMap still points at the cell cel keys directly: cel keys
  //    are flat across state.cels, so "A1" resolves regardless of
  //    which segment owns it. When step 3 introduces namespaced keys
  //    (Sheet1:A1), this inputMap gets rebuilt accordingly. ────────────
  const inputMap: Record<string, string> = {
    "__sheet:selected":     "__sheet:selected",
    "__sheet:selectionEnd": "__sheet:selectionEnd",
    "__sheet:editing":      "__sheet:editing",
    "__sheet:editSeed":     "__sheet:editSeed",
    "__sheet:sources":      "__sheet:sources",
    "__sheet:copyMark":     "__sheet:copyMark",
  };
  for (const addr of allAddresses()) inputMap[addr] = addr;

  controlCels.push({
    key: "appTree",
    l: "sheet:render",
    inputMap,
    segment: SHEET_CONTROLS_SEGMENT,
  });

  const fns = new Map<LambdaKey, Fn>([
    ["sheet:render",            renderApp],
    ["sheet:mouseDown",         mouseDown],
    ["sheet:mouseEnter",        mouseEnter],
    ["sheet:edit",              edit],
    ["sheet:editKeyDown",       editKeyDown],
    ["sheet:editBlur",          editBlur],
    ["sheet:typeIntoSelected",  typeIntoSelected],
    ["sheet:moveSelection",     moveSelection],
    ["sheet:formulaBarFocus",   formulaBarFocus],
    ["sheet:formulaBarKeyDown", formulaBarKeyDown],
    ["sheet:formulaBarBlur",    formulaBarBlur],
  ]);

  return {
    controls:  { key: SHEET_CONTROLS_SEGMENT, cels: controlCels },
    userSheet: { key: SHEET_SEGMENT,          cels: userCels    },
    fns,
  };
};
