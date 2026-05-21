import type {
  DehydratedCel, Fn, LambdaKey, Segment,
} from "../../../../plastron/src/index.js";
import { allAddresses } from "../domain/address.js";
import {
  SHEET_CONTROLS_SEGMENT, DEFAULT_SHEET_NAME, cellKeyFor, sheetSegmentFor,
} from "../domain/parse.js";
import { renderApp } from "../render/app.js";
import { infixFormula } from "../formula.js";
import { buildFormulaInputMap } from "../domain/parse.js";
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

type SheetSeed = Record<string, { v?: unknown; f?: string }>;

// Sheet1 — the ledger demo. Exercises arithmetic + SUM/ROUND/MIN/MAX/AVG/COUNT.
const SHEET1_SEED: SheetSeed = {
  A1: { v: "Item" },        B1: { v: "Qty" },   C1: { v: "Price" }, D1: { v: "Total" },
  A2: { v: "Bone, ox" },    B2: { v: 12 },      C2: { v: 4 },       D2: { f: "B2*C2" },
  A3: { v: "Plastron" },    B3: { v: 3 },       C3: { v: 17 },      D3: { f: "B3*C3" },
  A4: { v: "Charcoal" },    B4: { v: 30 },      C4: { v: 0.5 },     D4: { f: "B4*C4" },
  A5: { v: "Bronze pin" },  B5: { v: 8 },       C5: { v: 2.25 },    D5: { f: "B5*C5" },
  A7: { v: "Subtotal" },                                              D7: { f: "SUM(D2:D5)" },
  A8: { v: "Tax (10%)" },                                             D8: { f: "ROUND(D7*0.1, 2)" },
  A9: { v: "Grand total" },                                           D9: { f: "D7+D8" },
  F1: { v: "Stats" },
  F2: { v: "min price" },   G2: { f: "MIN(C2:C5)" },
  F3: { v: "max price" },   G3: { f: "MAX(C2:C5)" },
  F4: { v: "avg price" },   G4: { f: "ROUND(AVG(C2:C5), 2)" },
  F5: { v: "rows" },        G5: { f: "COUNT(B2:B5)" },
};

// Sheet2 — a function-library tour. Each row exercises one of the
// fn:* segments hydrated alongside the sheet. Multi-sheet means
// these formulas can sit alongside Sheet1's inventory ledger without
// either polluting the other's cell namespace.
//
// Formulas are intra-sheet — they reference Sheet2's own cells.
// Cross-sheet refs (`=Sheet1!D9`) are a follow-up that needs
// `IDENT!cellref` parser support.
const SHEET2_SEED: SheetSeed = {
  A1: { v: "Function tour" },
  // math (already in Sheet1; keep one example here for completeness)
  A2: { v: "x" },                B2: { v: 42 },
  A3: { v: "x²" },               B3: { f: "POW(B2, 2)" },
  A4: { v: "√x rounded" },       B4: { f: "ROUND(SQRT(B2), 3)" },

  // text — uses fn:CONCAT / LEFT / UPPER / LEN / SUBSTITUTE / REPT
  A6: { v: "—text—" },
  A7: { v: "greeting" },         B7: { v: "Hello, World" },
  A8: { v: "upper" },            B8: { f: "UPPER(B7)" },
  A9: { v: "first 5" },          B9: { f: "LEFT(B7, 5)" },
  A10: { v: "length" },          B10: { f: "LEN(B7)" },
  A11: { v: "replace" },         B11: { f: "SUBSTITUTE(B7, \"World\", \"Plastron\")" },
  A12: { v: "concat" },          B12: { f: "CONCAT(B8, \" — \", B11)" },

  // logic — uses fn:IF / IFERROR
  D1: { v: "—logic—" },
  D2: { v: "x>10" },             E2: { f: "IF(B2>10, \"big\", \"small\")" },
  D3: { v: "x even" },           E3: { f: "IF(B2 - ROUND(B2/2, 0)*2, \"odd\", \"even\")" },
  D4: { v: "safe div" },         E4: { f: "IFERROR(B2/0, \"divz\")" },

  // stats — uses fn:STDEV / MEDIAN / RANK over the existing math col
  D6: { v: "—stats—" },
  D7: { v: "stdev(B2:B4)" },     E7: { f: "ROUND(STDEV(B2, B3, B4), 2)" },
  D8: { v: "median" },           E8: { f: "MEDIAN(B2, B3, B4)" },

  // date — uses fn:TODAY / YEAR
  D10: { v: "—date—" },
  D11: { v: "today" },           E11: { f: "TODAY()" },
  D12: { v: "year"  },           E12: { f: "YEAR(E11)" },
};

const SHEETS: ReadonlyArray<{ name: string; seed: SheetSeed }> = [
  { name: "Sheet1", seed: SHEET1_SEED },
  { name: "Sheet2", seed: SHEET2_SEED },
];

const collectInitialSources = (): Record<string, string> => {
  // The sources side-table is a per-sheet view today (it's keyed by
  // bare addr — multiple sheets would collide). For multi-sheet, the
  // sources cel will become per-active-sheet at edit time; for now,
  // seed with the active sheet's formulas (Sheet1 — DEFAULT_SHEET_NAME).
  const out: Record<string, string> = {};
  const defaultSheet = SHEETS.find((s) => s.name === DEFAULT_SHEET_NAME);
  if (!defaultSheet) return out;
  for (const [addr, seed] of Object.entries(defaultSheet.seed)) {
    if (seed.f !== undefined) out[addr] = seed.f;
  }
  return out;
};

export interface BuiltSheetSegments {
  /** Workbook-level cels: __sheet:* control cels + appTree render +
   *  activeSheet + userSheets registry + sentinel. Lives at
   *  segment="sheet:controls" and persists across user-sheet
   *  add/remove. */
  controls: Segment;
  /** One Segment per user sheet, in display order. Each lives at
   *  segment="sheet:<Name>" and carries that sheet's cell cels. */
  userSheets: Segment[];
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
    // The active user sheet — tabs read this to know which to
    // highlight; the grid/toolbar read it to know which cells to
    // display. Tabs write to it on click.
    { key: "__sheet:activeSheet",  v: DEFAULT_SHEET_NAME,          segment: SHEET_CONTROLS_SEGMENT },
    // The list of user-sheet names in display order. The tab bar
    // reads this to emit one tab per entry. Adding/removing a sheet
    // is a write to this cel (plus a hydrate / flush of the
    // corresponding `sheet:<Name>` segment).
    { key: "__sheet:userSheets",   v: SHEETS.map((s) => s.name),   segment: SHEET_CONTROLS_SEGMENT },
  ];

  // ── One Segment per user sheet ──────────────────────────────────────────
  // Cell keys are namespaced (Sheet1:A1) so multiple user sheets can
  // hold the same bare addresses without colliding in state.cels.
  // Formula cels carry an explicit `inputMap` so deps resolve to the
  // right sheet-scoped keys without going through the kernel's
  // auto-wire (which would look for unprefixed "B2" and find nothing).
  const userSheets: Segment[] = SHEETS.map((sh) => {
    const cels: DehydratedCel[] = [];
    const segment = sheetSegmentFor(sh.name);
    for (const addr of allAddresses()) {
      const seed = sh.seed[addr];
      const key = cellKeyFor(sh.name, addr);
      if (seed?.f !== undefined) {
        const deps = infixFormula.extractDeps?.(seed.f) ?? [];
        const inputMap = buildFormulaInputMap(sh.name, deps);
        cels.push({ key, f: seed.f, segment, inputMap });
      } else {
        cels.push({ key, v: seed?.v ?? "", segment });
      }
    }
    return { key: segment, cels };
  });

  // ── appTree inputMap — control cels (bare keys) + every sheet's
  //    cells under sheet-prefixed input names. The render lambda
  //    reads control cels via bare keys (`inputs.__sheet:editing`)
  //    and per-sheet cells via `${sheet}!${addr}` style lookup
  //    (`inputs["Sheet1!A1"]`). renderApp narrows to the active
  //    sheet at render time. ────────────────────────────────────────
  const inputMap: Record<string, string> = {
    "__sheet:selected":     "__sheet:selected",
    "__sheet:selectionEnd": "__sheet:selectionEnd",
    "__sheet:editing":      "__sheet:editing",
    "__sheet:editSeed":     "__sheet:editSeed",
    "__sheet:sources":      "__sheet:sources",
    "__sheet:copyMark":     "__sheet:copyMark",
    "__sheet:activeSheet":  "__sheet:activeSheet",
    "__sheet:userSheets":   "__sheet:userSheets",
  };
  for (const sh of SHEETS) {
    for (const addr of allAddresses()) {
      inputMap[`${sh.name}!${addr}`] = cellKeyFor(sh.name, addr);
    }
  }

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
    controls: { key: SHEET_CONTROLS_SEGMENT, cels: controlCels },
    userSheets,
    fns,
  };
};
