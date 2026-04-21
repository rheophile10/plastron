import type { Cel } from "../types/cel.js";
import type {
  RecalculationConfig, ChangeIndexConfig, ChangeIndices, Errors,
} from "./types/config.js";
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

const configChangeIndexConfig: Cel = {
  key: "changeIndexConfig",
  name: "Change Index Config",
  description: "Named change-tracking indices. { indexName: tagList }. Empty tag list = catch-all.",
  v: {} satisfies ChangeIndexConfig,
  children: [],
  segment: "config",
};

const configChangeIndices: Cel = {
  key: "changeIndices",
  name: "Change Indices",
  description: "Runtime-populated each cycle, wave-partitioned. { indexName: Key[][] } — outer index = wave number.",
  v: {} satisfies ChangeIndices,
  children: [],
  segment: "config",
  dynamic: true,
};

const configErrors: Cel = {
  key: "errors",
  name: "Errors",
  description: "Runtime-populated. Map of cel key → ErrorInfo for cels in unrecovered error state.",
  v: {} satisfies Errors,
  children: [],
  segment: "config",
};

/** All cels in segment "config". */
export const configCells: Cel[] = [
  configRecalculation,
  configOpAliases,
  configSchemas,
  configChangeIndexConfig,
  configChangeIndices,
  configErrors,
];
