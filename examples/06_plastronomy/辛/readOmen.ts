// ============================================================================
// 辛/readOmen — the chisel that pronounces judgment.
//
// Given the crack-geometry and the king's charge (its length stands in
// for its weightiness), return the prognostication phrase that would
// be carved into the plastron's 占辭 field.
//
// The mapping is deliberately arbitrary — real readings were a matter
// of the diviner's trained eye and the king's patience.
// ============================================================================

import type { LambdaMetadata } from "../../../plastron/src/lambdas/types/lambda.js";

export const readOmen = ({ geometry, charge }: { geometry: string; charge: string }): string => {
  const weighty = charge.length > 15;
  if (geometry.startsWith("深裂")) return weighty ? "大吉 (great auspice)"      : "吉 (auspicious)";
  if (geometry.startsWith("雙叉")) return weighty ? "吉 (auspicious)"            : "中吉 (middling auspice)";
  if (geometry.startsWith("淺紋")) return weighty ? "凶 (inauspicious)"          : "小凶 (minor inauspice)";
  return                                     weighty ? "大凶 (great inauspice)"  : "凶 (inauspicious)";
};

export const readOmenMeta: LambdaMetadata = {
  key:          "readOmen",
  name:         "readOmen",
  description:  "Pronounce 吉/凶 from crack geometry and charge weight.",
  inputSchema:  "binopInput",
  outputSchema: "string",
  arity:        2,
  filename:     "examples/06_plastronomy/辛/readOmen.ts",
  source:       readOmen.toString(),
};
