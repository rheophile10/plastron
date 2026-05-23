import type { 甲骨, Cel, Fn, Key, State, ValueCel } from "../types/index.js";
import { bindNativeFns } from "./nativeFn.js";
import seed from "./cel-error.json" with { type: "json" };

/** Key of the locked ValueCel that accumulates every CelError seen by
 *  this State. Seeded in kernel-internal.ts; appended to by
 *  appendError(). The log is segment "kernel" so dehydrate excludes
 *  it — errors don't persist across boots. */
export const ERRORS_LOG_KEY: Key = "errors";

// ============================================================================
// cel-error — trap-as-value error schema.
//
// When a fireable cel's evaluator throws (formula compile error, wasm trap,
// JS exception, runtime panic, …) the kernel catches and replaces the
// would-be cel.v with a tagged error value matching this schema:
//
//   { kind: "error", at, trap, message, stack? }
//
// Downstream cels see it like any other value. A JS formula reading an
// error-valued input naturally propagates (Number(celError) is NaN; member
// access on it throws → caught at the next layer → another CelError). A
// formula written to short-circuit on errors can inspect the discriminator
// via isCelError(). Bridges to other kinds marshal CelError across kind
// boundaries the same way they marshal data.
//
// The schema lives as a SchemaCel ("cel-error") with three protocol fn
// cels — symmetric with everything in js-common-schema. Cels that hold
// CelError values (like the per-kind <kind>.errors log) attach this schema
// via cel.schema = state.cels.get("cel-error").v so the dehydrate path
// invokes cel-error_dehydrate to serialize them, and runCycle's
// isChanged-aware diff invokes cel-error_isChanged to skip no-op writes.
// ============================================================================

/** TS-side shape of a CelError. The canonical definition is the JSON
 *  Schema in cel-error.json; this type co-locates the shape for ergonomics
 *  inside kernel code that constructs error values. Keep the two in sync.
 *
 *  `at` is an array of cel keys so structural errors with no single
 *  owner (input cycle, compiler cycle, multi-cel validation) fit the
 *  same shape as per-cel runtime/compile errors. Length-1 array for
 *  per-cel; length-N for structural. */
export interface CelError {
  kind: "error";
  at: Key[];
  trap: string;
  message: string;
  stack?: string;
}

/** Runtime predicate — narrows unknown to CelError. Checks the discriminator
 *  + that `at` is a string array. */
export const isCelError = (v: unknown): v is CelError => {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.kind !== "error") return false;
  if (typeof o.trap !== "string" || typeof o.message !== "string") return false;
  if (!Array.isArray(o.at)) return false;
  for (const k of o.at) if (typeof k !== "string") return false;
  return true;
};

/** Build a CelError from a caught exception. Accepts either a single
 *  cel key or an array of keys (for cycles and other multi-cel traps);
 *  always stores the array form on the value. */
export const makeCelError = (at: Key | Key[], trap: string, e: unknown): CelError => {
  const atArr = Array.isArray(at) ? at : [at];
  if (e instanceof Error) {
    const out: CelError = { kind: "error", at: atArr, trap, message: e.message };
    if (e.stack) out.stack = e.stack;
    return out;
  }
  return { kind: "error", at: atArr, trap, message: String(e) };
};

/** Append a CelError to the state-level log. Idempotent under missing
 *  log cel (defensive — every State built via createInitialState has
 *  one, but host code calling makeCelError on a stripped-down state
 *  shouldn't crash). Cascade never re-fires on this push: the log is
 *  a ValueCel with a mutable array v, mutated in place — same pattern
 *  precomputedStates and compile.cache use. */
export const appendError = (state: State, error: CelError): void => {
  const log = state.cels.get(ERRORS_LOG_KEY) as ValueCel | undefined;
  if (!log) return;
  (log.v as CelError[]).push(error);
};

/** Reset the error log to empty. The host calls this when ready to
 *  surface errors to the user, before retrying a failed hydrate, or
 *  on a "dismiss" action — the kernel never auto-clears, so dev
 *  iterations on broken segments don't lose history mid-debug.
 *  Mutates the array in place (preserves the reference, same as
 *  appendError). No cascade fires; the log isn't reactive. */
export const clearErrors: Fn = (state: State) => {
  const log = state.cels.get(ERRORS_LOG_KEY) as ValueCel | undefined;
  if (log) (log.v as CelError[]).length = 0;
  return state;
};

// ── protocol implementations ────────────────────────────────────────────────

// isChanged — structural compare. Two CelErrors are equal iff their tag
// fields all match. Stack is intentionally excluded from the diff (it
// varies across V8 runs / source maps even for the "same" error). `at`
// is element-wise compared (reference equality on arrays would always
// say "changed").
export const cel_error_isChanged: Fn = (a, b) => {
  if (a === b) return false;
  if (!isCelError(a) || !isCelError(b)) return true;
  if (a.trap !== b.trap || a.message !== b.message) return true;
  if (a.at.length !== b.at.length) return true;
  for (let i = 0; i < a.at.length; i++) {
    if (a.at[i] !== b.at[i]) return true;
  }
  return false;
};

// hydrate / dehydrate — CelError is JSON-shaped by construction, so both
// directions are identity. (The schema's `additionalProperties: false`
// means a roundtripped CelError carries no surprise fields.)
export const cel_error_hydrate:   Fn = (v) => v;
export const cel_error_dehydrate: Fn = (v) => v;

export const name = "cel-error" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["cel-error_isChanged", cel_error_isChanged],
  ["cel-error_hydrate",   cel_error_hydrate],
  ["cel-error_dehydrate", cel_error_dehydrate],
]));
