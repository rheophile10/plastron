import type { Key } from "../../common.js";
import type { Cel } from "../../state/types/cel.js";
import type { Fn, LambdaMetadata } from "./lambda.js";
import type { FnRegistry } from "../../state/hydration/types.js";

// ========================================================================
// LambdaKindHandler — extension point for lambda execution backends.
//
// Plastron core knows about no specific kind. The "native" kind ships
// with core as a thin adapter over FnRegistry; every other kind
// (formula, quickjs, python, sqlite, eshkol, …) is registered by an
// extension package via runtime()'s `kinds` option.
//
// Each cel's kind is selected by cel.kind (with cel._lambdaMeta.kind as
// fallback). Defaults to "native" when neither is set.
// ========================================================================

/** Optional per-cel teardown invoked by flush. Lets handlers free
 *  WASM-side allocations, kill workers, finalize prepared statements. */
export type DisposeFn = () => void;

/** Result of preparing a lambda cel — the cycle-ready callable plus an
 *  optional cleanup. fn may be undefined if the lambda will be
 *  registered later via incremental hydrate (matches existing
 *  semantics — runCycle records "Lambda missing" via the errors cel on
 *  invoke). */
export interface CompiledLambda {
  fn?: Fn;
  dispose?: DisposeFn;
}

/** Information passed to a kind handler at hydrate time. Handlers
 *  inspect the cel and lambda metadata to decide what to compile. */
export interface KindContext {
  cel: Cel;
  meta: LambdaMetadata | undefined;
  /** The cels Map at hydrate time. Handlers that need to look up
   *  module cels (kind: "python" with imports, etc.) consult it. */
  cels: Map<Key, Cel>;
  /** Native FnRegistry. The "native" kind uses this; other kinds may
   *  consult it for fallback (e.g., a formula kind whose parser is
   *  itself a registered native fn). */
  fnRegistry: FnRegistry;
}

export interface LambdaKindHandler {
  /** Identifier used by cel.kind / LambdaMetadata.kind to select this
   *  handler. */
  key: string;
  /** Called once per cel during hydration. Returns a CompiledLambda
   *  whose fn will be invoked by the cycle. May throw if compilation
   *  fails irrecoverably. */
  prepare(ctx: KindContext): CompiledLambda;
}

/** Map from kind key to handler. Stored on State as state._kinds. */
export type KindRegistry = Record<string, LambdaKindHandler>;
