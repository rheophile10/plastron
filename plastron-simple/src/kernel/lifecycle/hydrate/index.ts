import type { Hydrate } from "../../../types/index.js";
import { precompute } from "../../precompute/index.js";
import { validateInputKinds } from "./input-kinds.js";
import { installMemoAndTrampolines } from "./memo-install.js";
import { resolveSchemas } from "./schema.js";
import { installCels, validateManifests } from "./segment.js";
import { applySchemaHydrate } from "./value.js";

// Re-export the per-entity helpers so other kernel modules (cel-body,
// flush, host code) can grab them directly without reaching into the
// subfolder structure.
export { inflateCel, disposeCel } from "./cel.js";
export { compileCelBody } from "./formula.js";
export { validateInputKinds } from "./input-kinds.js";
export { resolveSchemas } from "./schema.js";
export {
  installCels, inflateAllCels, compileFireable, validateManifests,
} from "./segment.js";
export { hydrateValue, applySchemaHydrate } from "./value.js";

// ============================================================================
// hydrate — fold incoming 甲骨[] + 冊[] into state.
//
// Order matters:
//   1. validateManifests   — fail-fast on missing deps before any
//                            mutation.
//   2. installCels         — inflate every dehydrated cel (pure
//                            construct), then topo-compile fireable
//                            cels with `f` so a compiler shipped in
//                            the same batch as the cels that name it
//                            compiles first.
//   3. resolveSchemas      — populate cel.schema from each cel's
//                            metadata.schema reference. Deferred until
//                            all cels exist so cross-segment refs work.
//   4. applySchemaHydrate  — walk every cel and run its schema's
//                            `protocols.hydrate` fn on cel.v (if
//                            declared). Inflates JSON-shaped values
//                            (e.g. RegExp, Uint8Array) into live form.
//                            Best-effort: silently skipped when the
//                            schema, the protocol fn, or the fn cel is
//                            absent.
//   5. precompute(state)   — rebuild waveCascade, children,
//                            dynamicCascade. Bumps generation.
//   6. record manifests    — only after precompute returns successfully,
//                            so a cycle/throw leaves state.segments
//                            untouched.
//
// Lambda fns no longer come through hydrate — every fn is owned by a
// cel in a segment (kernel-io, kernel-lifecycle, kernel-segments,
// js-compiler, ...) and gets installed via installCels above. The
// runtime fn lookup goes through resolveFn(state, key) which reads
// cel._fn (Lambda/Formula) or cel.v (CompilerCel).
// ============================================================================

export const hydrate: Hydrate = async (state, segments, manifests) => {
  validateManifests(state, manifests);
  await installCels(state, segments);
  validateInputKinds(state);
  resolveSchemas(state);
  applySchemaHydrate(state);
  installMemoAndTrampolines(state);
  precompute(state);
  for (const m of manifests) state.segments.set(m.name, m);
  return state;
};
