export { hydrate } from "./hydrate/index.js";
export { dehydrate } from "./dehydrate/index.js";
export { flush } from "./flush.js";

// Re-export hydrate/dehydrate sub-utilities so call sites can reach
// inflateCel, deflateCel, etc. through the lifecycle barrel instead
// of digging into the subfolders.
export {
  inflateCel, disposeCel, compileCelBody, resolveSchemas,
  installCels, inflateAllCels, compileFireable, validateManifests,
  hydrateValue, applySchemaHydrate,
} from "./hydrate/index.js";
export { deflateCel, dehydrateValue, collectManifests, groupCelsBySegment } from "./dehydrate/index.js";
