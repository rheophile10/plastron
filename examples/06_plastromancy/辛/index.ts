// ============================================================================
// 辛/index — the chisel rack. Collects every custom lambda's function
// + metadata and exposes the two bundles hydrate() expects.
// ============================================================================

import type { FnRegistry } from "../../../plastron/src/state/index.js";
import type { LambdaMetadata } from "../../../plastron/src/lambdas/types/lambda.js";

import { crackGeometry,   crackGeometryMeta }   from "./crackGeometry.js";
import { readOmen,        readOmenMeta }        from "./readOmen.js";
import { omenReport,      omenReportMeta }      from "./omenReport.js";
import { ancestorReport,  ancestorReportMeta }  from "./ancestorReport.js";
import { sessionReport,   sessionReportMeta }   from "./sessionReport.js";

export const 辛Fns: FnRegistry = {
  crackGeometry,
  readOmen,
  omenReport,
  ancestorReport,
  sessionReport,
};

export const 辛Meta: Record<string, LambdaMetadata> = {
  crackGeometry:  crackGeometryMeta,
  readOmen:       readOmenMeta,
  omenReport:     omenReportMeta,
  ancestorReport: ancestorReportMeta,
  sessionReport:  sessionReportMeta,
};
