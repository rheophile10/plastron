import type { Fn, LambdaKey, State } from "../../../plastron/src/index.js";
import {
  el, text, vnodeEquals, diffVNodes,
  VNODE_IS_CHANGED_KEY, VNODE_DIFF_KEY,
  type VNode,
} from "../../../segments/plastron-dom/src/index.js";
import { CRACK_IS_CHANGED_KEY, type Crack } from "./schemas.js";

// ============================================================================
// 辛 (chisel) — the lambdas of the rite, plus the SPA dispatchers.
//
// Computational lambdas:
//   • buildCrack — heat/thickness → crack value
//   • buildTree  — vnode summary of the whole rite, with control buttons
//
// Schema callbacks (registered via schemaMetadata):
//   • crackIsChanged — pattern equality, ignores intensity drift
//   • vnodeIsChanged / vnodeDiff — re-export plastron-dom's vnode shape
//
// Dispatcher fns (called by the painter on button clicks):
//   • session:hotter / cooler / thicker / thinner / nextCharge
//   They take state as the first arg, write to source cels, and let
//   the cascade do the rest.
// ============================================================================

const CHARGES = [
  "shall the king campaign against the Qiāng?",
  "shall we burn the bones for rain?",
  "will the harvest of millet be plentiful?",
  "is the ancestor 上甲 displeased?",
  "shall we offer the white horse?",
] as const;

interface CrackInputs { ratio: number }

const buildCrack: Fn = (inputs: CrackInputs): Crack => ({
  pattern:   inputs.ratio < 3 ? "X" : "Y",
  intensity: inputs.ratio,
});

interface TreeInputs {
  heat: number;
  thickness: number;
  charge: string;
  crack: Crack | null;
  omen: string | null;
}

const buildTree: Fn = (inputs: TreeInputs): VNode => {
  const { heat, thickness, charge, crack, omen } = inputs;
  const intensityStr = crack ? crack.intensity.toFixed(2) : "—";
  const patternStr   = crack ? crack.pattern : "—";

  return el("div", { class: "ritual" },
    el("h1", null, text("龜卜 — divination")),

    el("section", { class: "reading" },
      el("p", { class: "charge-label" }, text("charge")),
      el("p", { class: "charge" }, text(charge ?? "—")),
      el("p", { class: "crack-label" }, text("crack")),
      el("p", { class: "crack" }, text(`${patternStr} (intensity ${intensityStr})`)),
      el("p", { class: "omen-label" }, text("omen")),
      el("p", { class: "omen" }, text(omen ?? "—")),
    ),

    el("section", { class: "controls" },
      el("button", { onClick: { dispatch: "session:hotter" } },   text("煆 hotter")),
      el("button", { onClick: { dispatch: "session:cooler" } },   text("冷 cooler")),
      el("button", { onClick: { dispatch: "session:thicker" } },  text("厚 thicker")),
      el("button", { onClick: { dispatch: "session:thinner" } },  text("薄 thinner")),
      el("button", { onClick: { dispatch: "session:nextCharge" } }, text("貞 next charge")),
    ),

    el("p", { class: "dials" }, text(`heat = ${heat.toFixed(0)}, thickness = ${thickness.toFixed(0)}`)),
  );
};

// ─── schema callbacks ──────────────────────────────────────────────────────

const crackIsChanged: Fn = (prev: unknown, next: unknown): boolean => {
  const a = prev as Crack | null;
  const b = next as Crack | null;
  if (a === null || b === null) return a !== b;
  return a.pattern !== b.pattern;
};

const vnodeIsChanged: Fn = (prev: unknown, next: unknown): boolean => {
  if (prev === null || next === null) return prev !== next;
  return !vnodeEquals(prev as VNode, next as VNode);
};

const vnodeDiff: Fn = (prev: unknown, next: unknown) =>
  diffVNodes(prev as VNode | null, next as VNode);

// ─── dispatchers (button clicks) ───────────────────────────────────────────

const adjust = async (state: State, key: string, delta: number, min = 1): Promise<void> => {
  const cur = (state.cels.get(key)?.v as number | undefined) ?? min;
  const set = state.fns.get("set") as Fn;
  await set(state, key, Math.max(min, cur + delta));
};

const hotter:    Fn = async (...args: unknown[]) => { await adjust(args[0] as State, "heat",      +1); };
const cooler:    Fn = async (...args: unknown[]) => { await adjust(args[0] as State, "heat",      -1); };
const thicker:   Fn = async (...args: unknown[]) => { await adjust(args[0] as State, "thickness", +1); };
const thinner:   Fn = async (...args: unknown[]) => { await adjust(args[0] as State, "thickness", -1); };

const nextCharge: Fn = async (...args: unknown[]) => {
  const state = args[0] as State;
  const cur = (state.cels.get("charge")?.v as string | undefined) ?? CHARGES[0];
  const i = CHARGES.indexOf(cur as typeof CHARGES[number]);
  const next = CHARGES[(i + 1) % CHARGES.length];
  await (state.fns.get("set") as Fn)(state, "charge", next);
};

export const chiselFns: Map<LambdaKey, Fn> = new Map([
  ["buildCrack",          buildCrack],
  ["buildTree",           buildTree],
  [CRACK_IS_CHANGED_KEY,  crackIsChanged],
  [VNODE_IS_CHANGED_KEY,  vnodeIsChanged],
  [VNODE_DIFF_KEY,        vnodeDiff],
  ["session:hotter",      hotter],
  ["session:cooler",      cooler],
  ["session:thicker",     thicker],
  ["session:thinner",     thinner],
  ["session:nextCharge",  nextCharge],
]);
