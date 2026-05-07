import type { Fn, LambdaKey } from "../../../plastron/src/index.js";
import {
  el, text, vnodeEquals, diffVNodes,
  VNODE_IS_CHANGED_KEY, VNODE_DIFF_KEY,
  type VNode,
} from "../../../segments/plastron-dom/src/index.js";
import { CRACK_IS_CHANGED_KEY, type Crack } from "./schemas.js";

// ============================================================================
// 辛 (chisel) — the lambdas of the rite.
//
// • buildCrack turns a heat/thickness ratio into a crack value
//   (pattern X if the ratio is gentle, Y if violent).
// • buildTree composes a vnode summary of the reading.
// • crackIsChanged: schema-side change-detection that ignores
//   intensity drift.
// • vnodeIsChanged / vnodeDiff: re-export plastron-dom's vnode
//   schema callbacks under the lambda keys schemaMetadata expects.
// ============================================================================

interface CrackInputs {
  ratio: number;
}

const buildCrack: Fn = (inputs: CrackInputs): Crack => ({
  pattern:   inputs.ratio < 3 ? "X" : "Y",
  intensity: inputs.ratio,
});

interface TreeInputs {
  charge: string;
  crack: Crack | null;
  omen: string;
}

const buildTree: Fn = (inputs: TreeInputs): VNode => {
  const { charge, crack, omen } = inputs;
  const intensityStr = crack ? crack.intensity.toFixed(2) : "—";
  const patternStr   = crack ? crack.pattern : "—";
  return el(
    "section", { class: "reading" },
    el("h1", {}, text("龜卜 — divination")),
    el("p", { class: "charge" }, text(`charge: ${charge}`)),
    el("p", { class: "crack"  }, text(`crack: ${patternStr} (intensity ${intensityStr})`)),
    el("p", { class: "omen"   }, text(`omen: ${omen}`)),
  );
};

// Pattern-only equality: same pattern → not changed, regardless of
// intensity drift. Returns true when the value materially changed.
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

export const chiselFns: Map<LambdaKey, Fn> = new Map([
  ["buildCrack",          buildCrack],
  ["buildTree",           buildTree],
  [CRACK_IS_CHANGED_KEY,  crackIsChanged],
  [VNODE_IS_CHANGED_KEY,  vnodeIsChanged],
  [VNODE_DIFF_KEY,        vnodeDiff],
]);
