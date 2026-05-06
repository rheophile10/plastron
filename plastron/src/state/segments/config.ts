import type { Cel } from "../types/cel.js";
import type {
  RecalculationConfig,
} from "./types/config.js";
import type { SegmentRegistry } from "./types/segments.js";
import type { SchemaRecords } from "../../schemas/types/schema.js";
import { defaultAliases } from "../../lambdas/formula/aliases.js";

// ========================================================================
// Segment "config" — user-tunable defaults + runtime-populated
// bookkeeping cels. Users may override via hydrate upsert.
// ========================================================================

const configRecalculation: Cel = {
  key: "config_recalculation",
  name: "Recalculation Config",
  description: "Runtime recalculation mode, interval, and strictTypes flag",
  v: { mode: "automatic", intervalMs: 1000 } satisfies RecalculationConfig,
  children: [],
  segment: "config",
  schema: "recalcConfig",
  readOnly: true,
};

const configOpAliases: Cel = {
  key: "config_opAliases",
  name: "Operator Aliases",
  description: "Maps operator symbols and emojis to default lambda keys",
  v: defaultAliases,
  children: [],
  segment: "config",
  readOnly: true,
};

const configSchemas: Cel = {
  key: "config_schemas",
  name: "Schema Registry",
  description: "Registered zod schemas keyed by SchemaKey. Default schemas are merged at hydrate; users may add their own before or after.",
  v: {} satisfies SchemaRecords,
  children: [],
  segment: "config",
  readOnly: true,
};

const configSegmentRegistry: Cel = {
  key: "segmentRegistry",
  name: "Segment Registry",
  description: "Per-segment metadata (role, loadByDefault, dependencies, manifest). Populated by hydrate from HydrateOptions.segments. Consumers: load-policy filters, audit logs, devtools.",
  v: {} satisfies SegmentRegistry,
  children: [],
  segment: "config",
};

/** All cels in segment "config". */
export const configCells: Cel[] = [
  configRecalculation,
  configOpAliases,
  configSchemas,
  configSegmentRegistry,
];
