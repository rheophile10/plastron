// ============================================================================
// 辛/crackGeometry — the chisel that reads the crack's shape.
//
// Given how hard the brand pressed (heat) and the plastron's thickness
// at the crack, classify the resulting crack-geometry. A stand-in for
// actual geomantic reading; in real Shang practice a diviner would
// interpret the 兆 (crack-omen) by eye.
// ============================================================================

import type { LambdaMetadata } from "../../../plastron/src/lambdas/types/lambda.js";

export const crackGeometry = ({ heat, thickness }: { heat: number; thickness: number }): string => {
  if (heat > 5 && thickness < 3) return "深裂 (deep fissure)";
  if (heat > 5 && thickness >= 3) return "雙叉 (double fork)";
  if (heat <= 5 && thickness < 3) return "淺紋 (shallow marking)";
  return "微兆 (faint omen)";
};

export const crackGeometryMeta: LambdaMetadata = {
  key:          "crackGeometry",
  name:         "crackGeometry",
  description:  "Classify a crack's geometry from heat and plastron thickness.",
  inputSchema:  "binopInput",
  outputSchema: "string",
  arity:        2,
  filename:     "examples/06_plastromancy/辛/crackGeometry.ts",
  source:       crackGeometry.toString(),
};
