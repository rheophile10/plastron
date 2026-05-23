import type { Schema, State } from "../../../types/index.js";

// ============================================================================
// Schema hydration — resolve cel.metadata.schema (a Key referencing a
// schema cel) into the live cel.schema. Runs AFTER every cel in the
// hydrate batch has been installed, so cross-segment schema refs
// resolve cleanly regardless of segment order.
//
// Idempotent. Cels whose declared schema cel doesn't exist (yet)
// get cel.schema = undefined; the kernel falls back to reference-
// equality change detection until a later hydrate fills the gap.
// ============================================================================

export const resolveSchemas = (state: State): void => {
  for (const cel of state.cels.values()) {
    const schemaKey = cel.metadata.schema;
    if (!schemaKey) { cel.schema = undefined; continue; }
    const schemaCel = state.cels.get(schemaKey);
    if (!schemaCel) { cel.schema = undefined; continue; }
    cel.schema = schemaCel.v as Schema | undefined;
  }
};
