import type { ComputeCel, ComputeCelMetadata, State } from "../../../types/index.js";
import { isFireable } from "../../../types/index.js";
import { hasHooksOrCache, makeLambdaTrampoline, memoEligibility } from "../../hooks.js";
import { makeMemoCache } from "../../memo-cache.js";
import { appendError, makeCelError } from "../../../甲骨坑/cel-error.js";

// ============================================================================
// installMemoAndTrampolines — hydrate-time pass that:
//
//   1. For every fireable cel with metadata.memo, runs the eligibility
//      check; on pass, allocates cel._memoCache. On refuse, records a
//      CelError in the kernel error log and proceeds without cache.
//
//   2. For every LambdaCel (Editable/Locked) that has hooks or cache,
//      wraps cel._fn with the trampoline so calls from inside formula
//      evaluators transparently hit cache + hook pipeline.
//
// FormulaCels don't get a trampoline — their fire path in runCycle.ts
// branches on hasHooksOrCache directly and routes to runHookedExecution.
// LambdaCels need the wrap because their call site is inside compiled
// formula bodies that the kernel doesn't own.
//
// Runs after applySchemaHydrate (so cel.schema is populated for the
// eligibility check) and before precompute. See docs/1-design/3-accepted/03-caching/execution-hooks.md.
// ============================================================================

export const installMemoAndTrampolines = (state: State): void => {
  for (const cel of state.cels.values()) {
    if (!isFireable(cel)) continue;
    const meta = cel.metadata as ComputeCelMetadata;

    // 1. Cache allocation
    if (meta.memo) {
      const elig = memoEligibility(cel as ComputeCel, state);
      if (elig.ok) {
        cel._memoCache = makeMemoCache(meta.memo.maxEntries ?? 128);
      } else {
        appendError(state, makeCelError(
          [cel.metadata.key], "MemoEligibilityError", new Error(elig.reason),
        ));
      }
    }

    // 2. LambdaCel trampoline (FormulaCels handle the gate in runCycle)
    if (cel.celType === "EditableLambdaCel" || cel.celType === "LockedLambdaCel") {
      if (hasHooksOrCache(cel as ComputeCel) && cel._fn) {
        cel._fn = makeLambdaTrampoline(cel._fn, cel as ComputeCel, state);
      }
    }
  }
};
