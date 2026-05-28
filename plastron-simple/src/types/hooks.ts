import type { Key } from "./index.js";

// ============================================================================
// Execution-hook + memo types — see docs/1-design/3-accepted/03-caching/execution-hooks.md
// ============================================================================

/** L1 cache configuration. Lives on FormulaCel/LambdaCel metadata. */
export interface MemoConfig {
  /** LRU cap on cached entries. Default 128 when omitted. */
  maxEntries?: number;
}

/** L1 cache surface. Reference-keyed lookup over a tuple of input
 *  values. Implementations: kernel/memo-cache.ts:LruMemoCache. */
export interface MemoCache {
  get(keys: readonly unknown[]): { value: unknown } | undefined;
  set(keys: readonly unknown[], value: unknown): void;
  clear(): void;
  readonly size: number;
}

/** The accumulator that flows through the pre-fn → _fn → post-fn pipeline.
 *  Pre-fns receive it, may mutate it, and may set `output` to short-circuit
 *  _fn. Post-fns receive it after `output` (or `error`) is set, and may
 *  transform the result or surface side effects. Dropped after the cel's
 *  execution completes. See docs/1-design/3-accepted/03-caching/execution-hooks.md "Execution path" for
 *  the full sequence. */
export interface ExecutionAccumulator {
  /** Cel whose execution this accumulator wraps. */
  celKey: Key;
  /** Inputs to the cel — shape depends on cel kind:
   *  - FormulaCel: resolved inputMap object, `{ name: value, ... }`.
   *  - LambdaCel:  positional args array passed by the formula caller. */
  inputs: Record<string, unknown> | unknown[];
  /** `cel.v` before this fire/call. Useful for transforms that need
   *  the prior value (e.g., diff-based perf trackers). */
  prevValue: unknown;
  /** `performance.now()` at the start of the hooked execution. */
  startTimestamp: number;

  /** Populated either by _fn execution or by a pre-fn short-circuit.
   *  When set during the pre-fn reducer, subsequent pre-fns and _fn
   *  are skipped (post-fns still run). */
  output?: unknown;
  /** Set if _fn threw. Post-fns may recover (set output, clear error)
   *  or pass through. If still set after post-fns, the throw is
   *  re-raised. */
  error?: unknown;
  /** `performance.now()` after _fn returns (or after pre-fn short-circuit). */
  endTimestamp?: number;

  /** Hooks may add arbitrary fields; convention is to namespace by
   *  hook key (e.g. `acc["perf.spanId"] = "..."`). */
  [k: string]: unknown;
}

/** Hook fn signature. Either returns the (possibly modified)
 *  accumulator, returns undefined to keep it unchanged, or returns
 *  a Promise resolving to the same. The hooked execution path awaits
 *  if the return is a Promise. */
export type HookFn = (
  acc: ExecutionAccumulator,
  state: unknown,    // State, but kept opaque here to avoid a cycle
) => ExecutionAccumulator | undefined | Promise<ExecutionAccumulator | undefined>;
