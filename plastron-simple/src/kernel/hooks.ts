import type { ComputeCel, ExecutionAccumulator, Fn, State } from "../types/index.js";
import { resolveFn } from "./resolve-fn.js";

// ============================================================================
// Execution-hook runtime. See docs/1-design/3-accepted/03-caching/execution-hooks.md.
//
// hasHooksOrCache(cel): cheap predicate for the fast-path gate.
//
// runHookedExecution(state, cel, runFn, cacheKeys, inputs): the full path —
//   build accumulator → cache check → pre-fn reducer (with short-circuit) →
//   _fn → cache store → post-fn reducer → return acc.output (or throw).
//
// deriveCacheKeysFromInputMap: standard cache-key derivation for FormulaCels.
// LambdaCel trampolines (task 15) pass call args as cache keys directly.
// ============================================================================

export const hasHooksOrCache = (cel: ComputeCel): boolean =>
  cel._memoCache !== undefined
  || (cel.metadata.preFns !== undefined  && cel.metadata.preFns.length > 0)
  || (cel.metadata.postFns !== undefined && cel.metadata.postFns.length > 0);

export interface RunHookedOpts {
  /** Resolved inputs for FormulaCel (Record) or positional args for
   *  LambdaCel trampolines (array). Becomes `acc.inputs`. */
  inputs: Record<string, unknown> | unknown[];
  /** Key tuple for the L1 cache lookup, derived from `inputs`. Order
   *  must be stable across calls for the same input shape. */
  cacheKeys: readonly unknown[];
  /** Closure that runs the cel's _fn (or _evaluate). May return a
   *  Promise. Called only when no pre-fn short-circuits and no cache
   *  hit occurs. */
  runFn: () => unknown | Promise<unknown>;
}

export const runHookedExecution = async (
  state: State,
  cel: ComputeCel,
  opts: RunHookedOpts,
): Promise<unknown> => {
  const acc: ExecutionAccumulator = {
    celKey: cel.metadata.key,
    inputs: opts.inputs,
    prevValue: cel.v,
    startTimestamp: performance.now(),
  };

  // L1 cache check
  if (cel._memoCache) {
    const hit = cel._memoCache.get(opts.cacheKeys);
    if (hit) {
      acc.output = hit.value;
      acc.endTimestamp = performance.now();
      return runPostFnsAndReturn(state, cel, acc);
    }
  }

  // Pre-fn reducer; any pre-fn setting acc.output short-circuits _fn
  const preFns = cel.metadata.preFns;
  if (preFns) {
    for (const fnKey of preFns) {
      const fn = resolveFn(state, fnKey);
      if (!fn) continue;
      const result = await fn(acc, state);
      if (result !== undefined && result !== acc) Object.assign(acc, result);
      if (acc.output !== undefined) break;
    }
  }

  // Run _fn (only if no pre-fn supplied output)
  if (acc.output === undefined) {
    try {
      const r = opts.runFn();
      acc.output = r instanceof Promise ? await r : r;
    } catch (e) {
      acc.error = e;
    }
    acc.endTimestamp = performance.now();
  }

  // Store to L1 on miss (only when fn actually ran and succeeded)
  if (cel._memoCache && acc.error === undefined && acc.output !== undefined) {
    cel._memoCache.set(opts.cacheKeys, acc.output);
  }

  return runPostFnsAndReturn(state, cel, acc);
};

const runPostFnsAndReturn = async (
  state: State,
  cel: ComputeCel,
  acc: ExecutionAccumulator,
): Promise<unknown> => {
  const postFns = cel.metadata.postFns;
  if (postFns) {
    for (const fnKey of postFns) {
      const fn = resolveFn(state, fnKey);
      if (!fn) continue;
      const result = await fn(acc, state);
      if (result !== undefined && result !== acc) Object.assign(acc, result);
    }
  }
  if (acc.error !== undefined && acc.output === undefined) throw acc.error;
  return acc.output;
};

/** Derive cache keys for a FormulaCel from a resolved inputs record.
 *  Order is stable: inputMap declaration order. Iterates Object.keys
 *  to match v8's insertion-ordered Map semantics; same input shape
 *  always yields the same key sequence. */
export const deriveCacheKeysFromInputMap = (
  cel: ComputeCel,
  inputs: Record<string, unknown>,
): unknown[] => {
  const inputMap = cel.metadata.inputMap;
  if (!inputMap) return [];
  const keys: unknown[] = [];
  for (const name of Object.keys(inputMap)) {
    keys.push(inputs[name]);
  }
  return keys;
};

/** Wrap a LambdaCel's _fn with a memo + hooks trampoline. The
 *  resulting fn is callable identically to the original from inside
 *  formula evaluators (positional args; sync-or-Promise return).
 *
 *  Fast path: when only L1 cache is configured (no pre/post-fns), the
 *  trampoline stays sync — cache hits return the stored value directly.
 *  This preserves sync semantics for cels that only memoize.
 *
 *  Hook path: pre/post-fns add an async trip through runHookedExecution.
 *  Callers receive a Promise. Authors who add hooks accept this. */
export const makeLambdaTrampoline = (
  originalFn: Fn,
  cel: ComputeCel,
  state: State,
): Fn => {
  const hasPre  = (cel.metadata.preFns?.length ?? 0)  > 0;
  const hasPost = (cel.metadata.postFns?.length ?? 0) > 0;
  if (!hasPre && !hasPost) {
    // Sync L1-only path. Async _fn results store on resolution.
    return ((...args: unknown[]): unknown => {
      if (cel._memoCache) {
        const hit = cel._memoCache.get(args);
        if (hit) return hit.value;
      }
      const result = originalFn(...args);
      if (cel._memoCache) {
        if (result instanceof Promise) {
          result.then((v) => { cel._memoCache?.set(args, v); }, () => { /* don't cache failures */ });
        } else {
          cel._memoCache.set(args, result);
        }
      }
      return result;
    }) as Fn;
  }
  // Hook path: always async.
  return ((...args: unknown[]): Promise<unknown> =>
    runHookedExecution(state, cel, {
      inputs: args,
      cacheKeys: args,
      runFn: () => originalFn(...args),
    })
  ) as Fn;
};

/** Eligibility check at hydrate time. Throws on configurations that
 *  cannot be safely cached. Returns true when caching is allowed.
 *  Callers gate `_memoCache` allocation on the result. */
export const memoEligibility = (
  cel: ComputeCel,
  state: State,
): { ok: true } | { ok: false; reason: string } => {
  if (cel.dynamic === true) {
    return { ok: false, reason: `cel "${cel.metadata.key}" is dynamic — refires every cycle by intent; caching defeats it` };
  }
  const inputMap = cel.metadata.inputMap;
  if (!inputMap || Object.keys(inputMap).length === 0) {
    return { ok: false, reason: `cel "${cel.metadata.key}" has no inputMap — cache would never hit` };
  }
  // Walk each declared input's source cel. Two acceptance paths:
  //   • LockedLambdaCel / EditableLambdaCel / CompilerCel — their
  //     "value in formula context" is the callable (_fn / .v), which is
  //     stable between definition changes; invalidate(state, defKey)
  //     clears downstream caches on re-register / source-edit. So they
  //     are inherently memoSafe regardless of schema annotation.
  //   • Everything else (ValueCel, FormulaCel output, etc.) — the
  //     schema must declare memoSafe: true.
  for (const [name, ref] of Object.entries(inputMap)) {
    const refs = Array.isArray(ref) ? ref : [ref];
    for (const k of refs) {
      const upstream = state.cels.get(k);
      if (!upstream) {
        return { ok: false, reason: `cel "${cel.metadata.key}" input "${name}" → "${k}" is missing` };
      }
      if (upstream.celType === "LockedLambdaCel"
          || upstream.celType === "EditableLambdaCel"
          || upstream.celType === "CompilerCel") continue;
      const schema = upstream.schema;
      if (!schema || schema.memoSafe !== true) {
        const schemaKey = schema?.key ?? "<none>";
        return {
          ok: false,
          reason: `cel "${cel.metadata.key}" input "${name}" → "${k}" has schema "${schemaKey}" which is not memoSafe; refusing L1 cache`,
        };
      }
    }
  }
  return { ok: true };
};
