import type { Key, State } from "./index.js";
import type { Cel } from "./cels.js";
import type { SchemaKey } from "./schemas.js";

export type LambdaKey = Key;

// ============================================================================
// ResolvedInputs — inputMap resolved to live cel references, the shape
// precompute hands to Compiler.buildEvaluate. Mirrors cel._inputEntries
// content but keyed by name. Each value is either a single Cel, an
// array of Cels, or undefined when the declared upstream key didn't
// resolve at precompute time.
// ============================================================================

export type ResolvedInputs = Record<string, Cel | undefined | Array<Cel | undefined>>;

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
// envelope { fn, dispose?, buildEvaluate? }.
//
//   • dispose       — fires when the cel is overwritten, removed, or
//                     the registry entry is replaced.
//   • buildEvaluate — optional fast-path closure builder. Receives the
//                     resolved input cels (built by precompute alongside
//                     cel._inputEntries) and returns a zero-argument
//                     closure that the cascade calls in place of the
//                     usual fn(inputs) call. Lets a compiler that knows
//                     its dependency shape emit code that captures cel
//                     refs directly and skips the per-fire input-object
//                     allocation.
//
//                     The return type is `(() => unknown) | Promise<() => unknown>`
//                     — a synchronous build is fine for in-process
//                     compilers (formula codegen, hand-written JS), but
//                     compilers that need async setup (WASM module
//                     instantiation, worker spawn, network fetch of a
//                     compiled artifact) can return a Promise that the
//                     async optional precompute pass awaits before
//                     storing the closure on cel._evaluate.
//
//                     Receives the live `state` so the emitted closure
//                     can resolve through ref cels (cel.ref) at fire
//                     time without re-doing per-fire registry lookups.
//                     Compilers that don't read refs may ignore it.
//
//                     Compilers that don't supply this are unaffected —
//                     fireCel falls through to the standard gather-and-
//                     call path.
// ============================================================================

export interface CompiledEnvelope {
  fn: Fn;
  dispose?: () => void;
  buildEvaluate?: (state: State, inputs: ResolvedInputs) => (() => unknown) | Promise<() => unknown>;
}

export type CompiledLambda = Fn | CompiledEnvelope;

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
