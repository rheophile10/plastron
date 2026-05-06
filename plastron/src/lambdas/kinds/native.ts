import type { Fn } from "../types/lambda.js";
import type { LambdaKindHandler, KindContext, CompiledLambda } from "../types/kind.js";
import { defaultFns } from "../index.js";

// ========================================================================
// Native kind — the FnRegistry-backed default. Resolves cel.l against
// (in order): defaultFns (operators + formula), the user-supplied
// fnRegistry, and previously-hydrated cels carrying _fn (so a lambda
// registered in an earlier hydrate is visible to a later one).
//
// Returns { fn: undefined } when resolution fails. Existing semantics
// preserved: runCycle records "Lambda missing" via the errors cel when
// an unresolved fn is invoked.
// ========================================================================

const resolveFn = ({ cel, cels, fnRegistry }: KindContext): Fn | undefined => {
  if (!cel.l) return undefined;
  if (defaultFns[cel.l]) return defaultFns[cel.l];
  if (fnRegistry[cel.l]) return fnRegistry[cel.l];
  for (const c of cels.values()) {
    if (c.l === cel.l && c._fn) return c._fn;
  }
  return undefined;
};

export const nativeKind: LambdaKindHandler = {
  key: "native",
  prepare(ctx: KindContext): CompiledLambda {
    const fn = resolveFn(ctx);
    return fn ? { fn } : {};
  },
};
