import type { State } from "../../state/types/index.js";

// ========================================================================
// Default segments — drop-in segments that core used to do inline. They
// install themselves on a State by hydrating their cels and registering
// their hooks. None are required for plastron to function; runtime()
// and plastron() install them by default for ergonomic continuity.
//
// To opt out, pass `defaults: false` to runtime()/plastron(), or call
// hydrate() directly (the lower-level entry point installs nothing).
// ========================================================================

export {
  changeIndicesCels, changeIndicesHook, installChangeIndices,
  CHANGE_INDICES_SEGMENT,
} from "./changeIndices.js";

export {
  errorsCels, errorsHook, installErrors,
  ERRORS_SEGMENT,
} from "./errors.js";

import { installChangeIndices } from "./changeIndices.js";
import { installErrors } from "./errors.js";

/** Install every default segment on an existing State. Each install
 *  helper is idempotent. */
export const installAllDefaults = async (state: State): Promise<void> => {
  await installChangeIndices(state);
  await installErrors(state);
};
