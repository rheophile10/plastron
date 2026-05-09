import type {
  DehydratedCel, Fn, LambdaKey, Segment,
} from "../../../../plastron/src/index.js";
import { allAddresses } from "../domain/address.js";
import { SHEET_SEGMENT } from "../domain/parse.js";
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
  A7: { v: "Subtotal" },                                              D7: { f: "D2+D3+D4+D5" },
  A8: { v: "Tax (10%)" },                                             D8: { f: "D7*0.1" },
  A9: { v: "Grand total" },                                           D9: { f: "D7+D8" },
};

const collectInitialSources = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [addr, seed] of Object.entries(SEED)) {
    if (seed.f !== undefined) out[addr] = seed.f;
  }
  return out;
};

export const buildSheetSegment = (): { segment: Segment; fns: Map<LambdaKey, Fn> } => {
  const cels: DehydratedCel[] = [
    { key: "__sheet:selected",     v: "",                          segment: SHEET_SEGMENT },
    { key: "__sheet:selectionEnd", v: "",                          segment: SHEET_SEGMENT },
    { key: "__sheet:editing",      v: "",                          segment: SHEET_SEGMENT },
    { key: "__sheet:editSeed",     v: "",                          segment: SHEET_SEGMENT },
    { key: "__sheet:sources",      v: collectInitialSources(),     segment: SHEET_SEGMENT },
    { key: "__sheet:copyMark",     v: null,                        segment: SHEET_SEGMENT },
  ];

  for (const addr of allAddresses()) {
    const seed = SEED[addr];
    if (seed?.f !== undefined) {
      cels.push({ key: addr, f: seed.f, segment: SHEET_SEGMENT });
    } else {
      cels.push({ key: addr, v: seed?.v ?? "", segment: SHEET_SEGMENT });
    }
  }

  const inputMap: Record<string, string> = {
    "__sheet:selected":     "__sheet:selected",
    "__sheet:selectionEnd": "__sheet:selectionEnd",
    "__sheet:editing":      "__sheet:editing",
    "__sheet:editSeed":     "__sheet:editSeed",
    "__sheet:sources":      "__sheet:sources",
    "__sheet:copyMark":     "__sheet:copyMark",
  };
  for (const addr of allAddresses()) inputMap[addr] = addr;

  cels.push({
    key: "appTree",
    l: "sheet:render",
    inputMap,
    segment: SHEET_SEGMENT,
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

  return { segment: { key: SHEET_SEGMENT, cels }, fns };
};
