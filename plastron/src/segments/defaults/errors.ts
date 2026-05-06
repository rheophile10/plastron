import type { Key } from "../../common.js";
import type { State } from "../../state/types/index.js";
import type { Errors, ErrorInfo } from "../../state/segments/types/index.js";
import type { HookSubscription } from "../../state/cycle/hooks.js";
import type { DehydratedCel } from "../../state/hydration/types.js";

// ========================================================================
// Default segment — error tracking.
//
// Maintains the reserved `errors` cel: a map of cel-key → ErrorInfo for
// every cel currently in an unrecovered error state. Populated when a
// lambda invocation throws; cleared when a subsequent invocation of the
// same cel succeeds.
//
// Subscribes to afterLambdaInvoke. The hook event reports both
// successful and failed invocations, so error-tracking is purely a
// matter of toggling entries in the map.
// ========================================================================

export const ERRORS_SEGMENT = "errors" as const;

export const errorsCels: Record<Key, DehydratedCel> = {
  errors: {
    key: "errors",
    name: "Errors",
    description: "Runtime-populated. Map of cel key → ErrorInfo for cels in unrecovered error state.",
    segment: ERRORS_SEGMENT,
    v: {} satisfies Errors,
  },
};

const setError = (state: State, key: Key, err: unknown, inputs: Record<string, unknown>): void => {
  const errorsCel = state.Cels.get("errors");
  if (!errorsCel) return;
  const map = (errorsCel.v ?? {}) as Errors;
  const errorCode = (err instanceof Error && "code" in err)
    ? String((err as { code: unknown }).code)
    : "*";
  const info: ErrorInfo = {
    error: String(err),
    at: Date.now(),
    inputs,
    ...(errorCode !== "*" && { code: errorCode }),
  };
  map[key] = info;
  errorsCel.v = { ...map };
};

const clearError = (state: State, key: Key): void => {
  const errorsCel = state.Cels.get("errors");
  if (!errorsCel) return;
  const map = (errorsCel.v ?? {}) as Errors;
  if (key in map) {
    const next: Errors = {};
    for (const [k, v] of Object.entries(map)) {
      if (k !== key) next[k] = v;
    }
    errorsCel.v = next;
  }
};

/** Hook subscription that maintains the errors cel. */
export const errorsHook = (state: State): HookSubscription => ({
  id: "plastron-defaults:errors",
  afterLambdaInvoke: (e) => {
    if (e.error !== undefined) {
      setError(state, e.key, e.error, e.inputs);
    } else {
      clearError(state, e.key);
    }
  },
});

/** Install the errors default segment on an existing State. Idempotent. */
export const installErrors = async (state: State): Promise<void> => {
  if (state.Cels.has("errors") && state.Cels.get("errors")?.segment === ERRORS_SEGMENT) {
    return; // already installed by this segment
  }
  await state.hydrate!(
    [errorsCels],
    [],
    {},
    {
      segments: {
        [ERRORS_SEGMENT]: {
          key: ERRORS_SEGMENT,
          role: "system",
          description: "Default segment — per-cel error capture from afterLambdaInvoke.",
        },
      },
      hooks: errorsHook(state),
      upsert: true, // tolerate the legacy config-segment errors cel during transition
    },
  );
};
