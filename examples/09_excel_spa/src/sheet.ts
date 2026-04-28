import { runtime, replaceCels } from "../../../plastron/src/index.js";
import type { State, DehydratedCel } from "../../../plastron/src/state/index.js";
import { excel, excelMeta } from "../../08_excel/parser.js";

export type CellKey = string;

export const COLS = ["A", "B", "C", "D", "E", "F"] as const;
export const ROWS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export const allKeys = (): CellKey[] => {
  const keys: CellKey[] = [];
  for (const r of ROWS) for (const c of COLS) keys.push(`${c}${r}`);
  return keys;
};

const initialCels = (): Record<CellKey, DehydratedCel> => {
  const cels: Record<CellKey, DehydratedCel> = {};
  for (const k of allKeys()) cels[k] = { key: k, segment: "sheet", v: "" };
  // Seed a few cells so the demo has something to show on first paint.
  cels.A1 = { key: "A1", segment: "sheet", v: 10 };
  cels.A2 = { key: "A2", segment: "sheet", v: 20 };
  cels.A3 = { key: "A3", segment: "sheet", v: 30 };
  cels.B1 = { key: "B1", segment: "sheet", f: "=SUM(A1, A2, A3)" };
  cels.B2 = { key: "B2", segment: "sheet", f: "=A1*2" };
  cels.C1 = { key: "C1", segment: "sheet", f: "=B1+B2" };
  cels.C2 = { key: "C2", segment: "sheet", f: "=IF(C1>50, \"big\", \"small\")" };
  return cels;
};

export const bootSheet = async (): Promise<State> => {
  const rt = await runtime();

  // Swap the default formula parser for the Excel one.
  const recalcCfg = rt.Cels.get("config_recalculation")!;
  recalcCfg.v = { ...(recalcCfg.v as object), formulaParser: "excel" };

  // Catch-all change index so we can read every cel that fires per cycle.
  // The default config has no indexes — we add "all" with an empty tag
  // list, which means "match every cel".
  const cic = rt.Cels.get("changeIndexConfig")!;
  cic.v = { all: [] };

  await rt.hydrate(
    [initialCels()],
    [{ excel: excelMeta }],
    { excel },
  );
  rt.flush("helloWorld");
  return rt;
};

// Parse user-typed text into a DehydratedCel.
//  ""        → empty variable
//  "=…"      → formula
//  numeric   → number variable
//  otherwise → string variable
export const parseRaw = (key: CellKey, text: string): DehydratedCel => {
  const trimmed = text.trim();
  if (trimmed === "")        return { key, segment: "sheet", v: "" };
  if (trimmed.startsWith("=")) return { key, segment: "sheet", f: trimmed };
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return { key, segment: "sheet", v: parseFloat(trimmed) };
  }
  return { key, segment: "sheet", v: text };
};

// What the user would type to reproduce the current cel — formula text
// for f-cels, value for v-cels.
export const rawText = (rt: State, key: CellKey): string => {
  const cel = rt.Cels.get(key);
  if (!cel) return "";
  if (cel.f !== undefined) return cel.f;
  if (cel.v === null || cel.v === undefined || cel.v === "") return "";
  return String(cel.v);
};

// Snapshot the dehydratable form of a cel — used for revert on error.
export const snapshotCel = (rt: State, key: CellKey): DehydratedCel => {
  const cel = rt.Cels.get(key);
  if (!cel) return { key, segment: "sheet", v: "" };
  const dc: DehydratedCel = { key, segment: cel.segment ?? "sheet" };
  if (cel.f !== undefined) dc.f = cel.f;
  else dc.v = cel.v;
  return dc;
};

export const commitCel = async (
  rt: State,
  key: CellKey,
  text: string,
): Promise<void> => {
  await replaceCels(rt, [{ [key]: parseRaw(key, text) }]);
};
