import type { Key, Common, varName } from "../../common.js";
import type { Fn, LambdaKey, LambdaMetadata } from "../../lambdas/types/lambda.js";
import type { SchemaKey } from "../../schemas/types/schema.js";

// ========================================================================
// Change detection
// ========================================================================

/** Predicate that decides whether a change from `current` to `next` is
 *  meaningful enough to propagate downstream. Return true to propagate,
 *  false to treat the cel as unchanged and prune the cascade. */
export type IsChanged = (current: unknown, next: unknown) => boolean;

// ========================================================================
// Cel — one unified cel type. Roles are expressed by optional fields:
//   * variable       — no `l`, no `readOnly`
//   * constant       — `readOnly: true`
//   * lambda         — `l` + `inputMap` (or `f` as shorthand)
//
// Wave-based execution:
//   `wave` declares a floor. Precompute auto-bumps to max(declared,
//   input waves). Within a wave, topological order; across waves, N
//   fully before N+1.
// ========================================================================

export interface Cel extends Common {
  key:           Key;
  v:             unknown;
  children:      Key[];

  /** Segment this cel belongs to. Populated by hydration; used by flush. */
  segment?:      Key;

  schema?:       SchemaKey;
  layer?:        number;

  /** Per-cel change predicate. Default: !Object.is(a, b). */
  isChanged?:    IsChanged;

  tags?:         string[];

  readOnly?:     boolean;

  /** Lambda key. Presence makes this cel "computed." Mutually exclusive with `f`. */
  l?:            LambdaKey;

  /** Maps lambda input names to upstream cel keys. */
  inputMap?:     Record<varName, Key | Key[]>;

  /** Inline formula string. Evaluated via config_recalculation.formulaParser.
   *  Deps auto-extracted at hydrate. Mutually exclusive with `l` + `inputMap`. */
  f?:            string;

  /** If true, recomputes every cycle regardless of whether inputs changed. */
  dynamic?:      boolean;

  /** Declared wave index. Default 0. */
  wave?:         number;

  /** How many past outputs to retain in `_prev`. Default 0. */
  prevDepth?:    number;

  /** Engine-maintained rolling buffer of past outputs, most-recent first. */
  _prev?:        unknown[];

  /** Hydrated — direct function reference for fast dispatch. */
  _fn?:          Fn;

  /** Hydrated — static metadata for the lambda (schemas, arity, key). */
  _lambdaMeta?:  LambdaMetadata;

  /** Hydrated — direct references to input cels. */
  _inputRefs?:   Record<varName, Cel | Cel[]>;

  /** Transient — set by input.touch() to force a lambda cel to re-run
   *  despite unchanged inputs. Cleared by runCycle after processing. */
  _touched?:     boolean;
}
