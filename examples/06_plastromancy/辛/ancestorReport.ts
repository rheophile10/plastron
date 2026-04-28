// ============================================================================
// 辛/ancestorReport — the chisel that inscribes the lineage scroll.
//
// Reads the three ancestor cels (passed as an array via inputMap) and
// returns a formatted multi-line string.
// ============================================================================

import type { LambdaMetadata } from "../../../plastron/src/lambdas/types/lambda.js";

type Ancestor = { name: string; weight: number };

export const ancestorReport = ({ ancestors }: { ancestors: Ancestor[] }): string =>
  ancestors
    .map(a => `  ${a.name.padEnd(22)} (weight ${a.weight})`)
    .join("\n");

export const ancestorReportMeta: LambdaMetadata = {
  key:          "ancestorReport",
  name:         "ancestorReport",
  description:  "Compose the ancestor catalog into a lineage scroll.",
  inputSchema:  "itemsInput",
  outputSchema: "string",
  arity:        1,
  filename:     "examples/06_plastromancy/辛/ancestorReport.ts",
  source:       ancestorReport.toString(),
};
