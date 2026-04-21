import type { Key } from "../../common.js";
import type { Cel } from "./cel.js";
import type { Cascade, WavedCascade, Input } from "../cycle/types.js";
import type { DehydratedCel, FnRegistry, HydrateOptions } from "../hydration/types.js";
import type { LambdaMetadata } from "../../lambdas/types/lambda.js";

// ========================================================================
// State — the engine's state object. Everything travels on State:
//
//   Cels     — Map<Key, Cel>. All cels live here (user + config + indexes).
//   flush    — segment flush: removes all cels whose segment matches.
//   hydrate  — incremental hydration: add more segments / lambdas into
//              the same state. Re-runs precompute and primes new lambdas.
//   cycle    — cycle-runner closure, set by createRuntime.
//   input    — write + read surface (set / batch / touch / consume /
//              get / buffer).
// ========================================================================

export interface State {
  /** The cels map. */
  Cels: Map<Key, Cel>;

  /** Segment flush — removes all cels whose `segment` matches. */
  flush: (segmentKey: Key) => void;

  /** Incremental hydrate — merge more cels / lambdas into this state.
   *  Runs precompute and primes any newly-added null lambda cels. */
  hydrate: (
    cels: Record<Key, DehydratedCel>[],
    lambdas?: Record<Key, LambdaMetadata>[],
    fnRegistry?: FnRegistry,
    options?: HydrateOptions,
  ) => Promise<State>;

  /** Cycle-runner closure, set by createRuntime after precompute. */
  cycle?: (cascade: WavedCascade) => Promise<void>;

  /** Write + read surface, attached by createRuntime. */
  input?: Input;
}

export type { Cascade, WavedCascade };
