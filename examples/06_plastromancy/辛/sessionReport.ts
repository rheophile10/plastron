// ============================================================================
// 辛/sessionReport — the chisel that frames the omen scroll with a
// heading. Given the current label and the omenReport body, emits the
// full block that the orchestrator prints.
// ============================================================================

import type { LambdaMetadata } from "../../../plastron/src/lambdas/types/lambda.js";

export const sessionReport = ({ label, body }: { label: string; body: string }): string =>
  `\n— ${label} —\n${body}`;

export const sessionReportMeta: LambdaMetadata = {
  key:          "sessionReport",
  name:         "sessionReport",
  description:  "Frame the omen scroll with a heading label.",
  inputSchema:  "binopInput",
  outputSchema: "string",
  arity:        2,
  filename:     "examples/06_plastromancy/辛/sessionReport.ts",
  source:       sessionReport.toString(),
};
