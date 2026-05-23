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
// ============================================================================

export const dehydrate: Dehydrate = (state) => ({
  segments: groupCelsBySegment(state),
  manifests: collectManifests(state),
});
