import type { Cel, JsonValue, State } from "../../../types/index.js";
import { resolveFn } from "../../resolve-fn.js";

// ============================================================================
// Schema dehydration — produce the JSON-shaped form of a live cel
// value via its schema's `dehydrate` protocol. Falls back to
// pass-through when the cel has no schema or no dehydrate protocol
// (assumes the value is already JSON-shaped; lossy if it isn't).
//
// The schema's protocol field is a Key; the fn is resolved from the
// cel registry via resolveFn at call time.
// ============================================================================

export const dehydrateValue = (cel: Cel, state: State): JsonValue | undefined => {
  if (cel.v === null || cel.v === undefined) return undefined;
  const fnKey = cel.schema?.protocols.dehydrate;
  if (fnKey) {
    const fn = resolveFn(state, fnKey);
    if (fn) return fn(cel.v) as JsonValue;
  }
  return cel.v as JsonValue;
};
