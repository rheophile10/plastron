import type { Key } from "../../common.js";
import type { Cel } from "./cel.js";
import type { Cascade, WavedCascade, Input } from "../cycle/types.js";
import type { HookSubscription } from "../cycle/hooks.js";
import type { DehydratedCel, FnRegistry, HydrateOptions } from "../hydration/types.js";
import type { LambdaMetadata } from "../../lambdas/types/lambda.js";
import type { KindRegistry } from "../../lambdas/types/kind.js";
import type { TagRegistry } from "./tags.js";
import type { FingerprintComponents } from "../fingerprint.js";

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

  /** Registered lambda-kind handlers. The "native" handler is registered
   *  during bootstrap; user-supplied kinds merge in via HydrateOptions.kinds.
   *  Hydration uses this registry to dispatch lambda preparation. */
  _kinds?: KindRegistry;

  /** Cycle hook subscribers. Accumulated across hydrate calls. Walked
   *  by runCycle and hydrate at well-defined points; subscribers are
   *  fire-and-forget observers — never replace cycle behaviour. */
  _hooks?: HookSubscription[];

  /** Format-tagged value protocol registry. Keyed by tag identifier;
   *  entries supply comparator/release/serialize/deserialize for opaque
   *  cel values. Untagged values fall through to default behaviour. */
  _tags?: TagRegistry;

  /** Trust policy identifier set by an extension package (e.g.
   *  plastron-trust). Captured in the runtime fingerprint so two
   *  runtimes with different trust postures don't share an identity.
   *  Plastron core never sets this. */
  _trustPolicy?: string;

  /** Lazy content-addressed identifier of the runtime composition
   *  (engine version + kinds + hooks + segments + tags + trustPolicy).
   *  Computed on demand; cheap. Async because it uses
   *  globalThis.crypto.subtle. */
  fingerprint?: () => Promise<string>;

  /** Structured form of the fingerprint inputs. Useful for devtools,
   *  bug reports, and audit-log entries that want the raw components. */
  fingerprintComponents?: () => FingerprintComponents;
}

export type { Cascade, WavedCascade };
