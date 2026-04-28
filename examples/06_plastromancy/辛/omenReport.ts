// ============================================================================
// 辛/omenReport — the chisel that composes the session's display scroll.
//
// Reads the four derived cels of a divination session and returns a
// multi-line string ready for console.log. Carving the display into a
// cel means the orchestrator doesn't reach into four cels and build a
// string by hand — it just 察's one cel.
// ============================================================================

import type { LambdaMetadata } from "../../../plastron/src/lambdas/types/lambda.js";

export const omenReport = (
  { preface, omen, geometry, prognostication }: {
    preface: string;
    omen: string;
    geometry: string;
    prognostication: string;
  },
): string =>
  `  前辭   ${preface}\n` +
  `  兆     ${omen}\n` +
  `  幾何   ${geometry}\n` +
  `  占辭   ${prognostication}`;

export const omenReportMeta: LambdaMetadata = {
  key:          "omenReport",
  name:         "omenReport",
  description:  "Compose the four session cels into a multi-line display scroll.",
  inputSchema:  "object",
  outputSchema: "string",
  arity:        4,
  filename:     "examples/06_plastromancy/辛/omenReport.ts",
  source:       omenReport.toString(),
};
