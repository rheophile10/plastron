import type { Fn, LambdaMetadata } from "../../../../plastron/src/lambdas/types/lambda.js";
import { tagged } from "../../../../plastron/src/index.js";
import type { TaggedValue } from "../../../../plastron/src/index.js";
import type { CrackValue } from "../tags/crack.js";
import type { OmenReading } from "../kinds/augur.js";

// ========================================================================
// 辛 — Chisels.
//
// Native plastron lambdas, used alongside the formula DSL (preface,
// inscription) and the augur kind (omen). Each chisel is a pure
// function over its inputs.
//
// carveCrack    — derives a tagged "crack" value from heat + thickness.
// renderOmen    — builds a one-line summary from omen + crack.
// renderSession — builds a multi-line scroll: heading + inscription.
// renderAncestors — formats the catalog as bullet lines.
// ========================================================================

const carveCrack: Fn = (inputs) => {
  const i = inputs as { heat?: number; thickness?: number };
  const heat = i.heat ?? 0;
  const thickness = i.thickness ?? 1;
  const ratio = heat / Math.max(thickness, 0.001);

  let pattern: CrackValue["pattern"];
  if (ratio < 1)      pattern = "indistinct";
  else if (ratio < 2) pattern = "I";
  else if (ratio < 3) pattern = "Y";
  else if (ratio < 4) pattern = "X";
  else                pattern = "double-Y";

  const intensity = Math.min(1, ratio / 5);
  return tagged<CrackValue>("crack", {
    pattern,
    intensity,
    notes: [`heat=${heat}, thickness=${thickness}, ratio=${ratio.toFixed(2)}`],
  });
};

const renderOmen: Fn = (inputs) => {
  const i = inputs as { omen: OmenReading; crack: TaggedValue<CrackValue> };
  const cv = i.crack?.value;
  const intensity = cv?.intensity ?? 0;
  return `${i.omen.omen} (${i.omen.note}; pattern=${cv?.pattern ?? "?"}, intensity=${intensity.toFixed(2)})`;
};

const renderSession: Fn = (inputs) => {
  const i = inputs as { label: string; inscription: string };
  return `\n— ${i.label} —\n${i.inscription}\n`;
};

const renderAncestors: Fn = (inputs) => {
  const i = inputs as { ancestors: Array<{ name: string; title: string }> };
  const list = i.ancestors ?? [];
  return [
    "祖先 (Ancestors):",
    ...list.map((a) => `  · ${a.name} — ${a.title}`),
  ].join("\n");
};

export const chiselFns: Record<string, Fn> = {
  carveCrack,
  renderOmen,
  renderSession,
  renderAncestors,
};

/** Chisel metadata used by the session bundle. */
export const sessionChiselMeta: Record<string, LambdaMetadata> = {
  carveCrack: {
    key: "carveCrack",
    description: "Carve a crack from heat + thickness; returns a tagged 'crack' value.",
    arity: 2,
    source: carveCrack.toString(),
  },
  renderOmen: {
    key: "renderOmen",
    description: "Render the omen reading with crack details.",
    arity: 2,
    source: renderOmen.toString(),
  },
  renderSession: {
    key: "renderSession",
    description: "Render the full session inscription with label.",
    arity: 2,
    source: renderSession.toString(),
  },
};

/** Chisel metadata used by the ancestors bundle. */
export const ancestorsChiselMeta: Record<string, LambdaMetadata> = {
  renderAncestors: {
    key: "renderAncestors",
    description: "Render the ancestor catalog as a multi-line string.",
    arity: 1,
    source: renderAncestors.toString(),
  },
};
