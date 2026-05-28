import type { Dehydrate } from "../../../types/index.js";
import { collectManifests, groupCelsBySegment } from "./segment.js";

// Re-export the per-entity helpers so other kernel modules / host code
// can grab them directly.
export { deflateCel } from "./cel.js";
export { dehydrateValue } from "./schema.js";
export { collectManifests, groupCelsBySegment } from "./segment.js";

// ============================================================================
// dehydrate — decompose a State into JSON-serializable {segments, manifests}.
// Inverse of hydrate; lossy where Zod schemas carry refinements,
// transforms, or brands.
//
// opts.onlySegments — when present, restrict output to those segment
// names. Useful for apps that want to ship just their user segment
// (e.g. pictograph's "象形") without also re-emitting every boot-
// loaded kernel segment (csp, js-compiler, cel-error, ...) which
// createInitialState re-seeds anyway.
// ============================================================================

export const dehydrate: Dehydrate = (state, opts) => {
  const filter = opts?.onlySegments ? new Set(opts.onlySegments) : undefined;
  return {
    segments: groupCelsBySegment(state, filter),
    manifests: collectManifests(state, filter),
  };
};
