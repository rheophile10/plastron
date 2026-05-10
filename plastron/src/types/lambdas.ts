import type { Key } from "./index.js";
import type { SchemaKey } from "./schemas.js";

export type LambdaKey = Key;

// Variadic so the registry accepts both `(input) => …` style fns
// (runCycle, hydrate-ish wrappers) and positional ones (get, set,
// hydrate, dehydrate). The generic params are kept for documentation
// at definition sites but the call signature itself is loose — kernel
// dispatch is dynamic, so registry assignability has to allow it.
export interface Fn<_I = unknown, O = unknown> {
  (...args: any[]): O | Promise<O>;
  /** Compiler-shaped fns may carry this. Returns the cel keys a
   *  source string references; used by hydrate / setCel to auto-wire
   *  inputMap on cels with cel.f. */
  extractDeps?: (source: string) => Key[];
}

// ============================================================================
// Compiler convention — any fn registered in state.fns under a key like
// "f", "py", "scheme", "wasm", … that consumes a source string and
// returns a runtime body. Cels with cel.f set look up their compiler at
// state.fns.get(cel.l ?? "f"); the result populates cel._fn.
//
// A compiler may return either a bare Fn (the runtime body) or an
// envelope { fn, dispose? } — the dispose hook fires when the cel is
// overwritten, removed, or the registry entry is replaced.
// ============================================================================

export type CompiledLambda = Fn | { fn: Fn; dispose?: () => void };

export interface Compiler extends Fn {
  (source: string): CompiledLambda;
  extractDeps?: (source: string) => Key[];
}

/** Static description of a lambda — kind, schemas, source, etc.
 *  Travels with the cel graph through JSON; the actual function is
 *  supplied separately via the `fns` parameter to hydrate. */
export interface LambdaMetadata {
  key: LambdaKey;
  /** Lambda kind. Defaults to "native" (FnRegistry-backed) when unset.
   *  Other kinds — formula, quickjs, python, sqlite, eshkol, etc. —
   *  are registered by extension packages. */
  kind?: string;
  /** Registered schema key for the lambda's input shape. */
  inputSchema?: SchemaKey;
  /** Registered schema key for the lambda's output shape. */
  outputSchema?: SchemaKey;
  /** Positional arity — enforced by formula parsers for exact arg-count match. */
  arity?: number;
  /** Relative path (from src/lambdas/) to the file the fn lives in. */
  filename?: string;
  /** Stringified function body. For non-native kinds, the source the
   *  kind handler will compile (Python source, Scheme expression, etc.). */
  source?: string;
  /** When true, hydrate will not overwrite an existing fn entry at
   *  this key. Used to protect built-in fns (hydrate, runCycle, get,
   *  set, …) from being clobbered by a misbehaving segment. */
  locked?: boolean;
}
