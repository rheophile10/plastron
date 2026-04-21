import type { Key } from "../../common.js";

// ========================================================================
// Cascade shapes
// ========================================================================

/** A layered set of cels to visit during recalc. Each inner array is
 *  one topological layer (processed in parallel); layers run in order. */
export type Cascade = Key[][];

/** A cascade partitioned by wave. Wave N runs after wave N-1 finishes.
 *  Keys are wave indices; values are the per-wave layered cascade. */
export type WavedCascade = Map<number, Cascade>;

// ========================================================================
// Input — the write + read surface attached to State by createRuntime.
// ========================================================================

export interface Input {
  /** Read a cel's value — equivalent to `state.Cels.get(key)?.v`. */
  get(key: Key): unknown;

  /** Write a single cel value. In automatic mode, recalculates immediately. */
  set(key: Key, value: unknown): Promise<void>;

  /** Write multiple cels; recalculate once with their merged cascade. */
  batch(writes: Array<[Key, unknown]>): Promise<void>;

  /** Force a cel (and its downstream cascade) to recompute even if no
   *  input changed. If the cel is a lambda, it re-runs. */
  touch(key: Key): Promise<void>;

  /** Drain the pending buffer and run a cycle. Useful in manual mode. */
  consume(): Promise<void>;

  /** Live pending cascade — the work `consume()` will run next. */
  buffer: WavedCascade;
}
