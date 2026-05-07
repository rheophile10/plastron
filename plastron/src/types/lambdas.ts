import type { Key } from "./index.js";
import type { SchemaKey } from "./schemas.js";

export type LambdaKey = Key;
export type KindKey = Key;

// Variadic so the registry accepts both `(input) => …` style fns
// (runCycle, hydrate-ish wrappers) and positional ones (get, set,
// hydrate, dehydrate). The generic params are kept for documentation
// at definition sites but the call signature itself is loose — kernel
// dispatch is dynamic, so registry assignability has to allow it.
export interface Fn<_I = unknown, O = unknown> {
  (...args: any[]): O | Promise<O>;
  /** Only the formula-parser fn carries this. Returns the cel keys a
   *  formula string references; used by hydrate to auto-wire inputMap. */
  extractDeps?: (formula: string) => Key[];
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
