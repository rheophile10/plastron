import type { Fn, LambdaKey, LambdaMetadata } from "../types/index.js";
import { hydrate, dehydrate } from "./hydrate.js";
import { runCycle } from "./runCycle.js";
import { get, set, batch, touch, consume } from "./input.js";
import { flush } from "./flush.js";
import { compileFormula, extractDeps } from "./formula.js";

// ============================================================================
// coreFns + coreFnMetadata — the default fn registry and the parallel
// metadata that drives lock policy. createInitialState clones both
// into state.fns and state.fnMetadata.
//
// state.fns is bare Fn (no per-entry record). The locked attribute
// lives on LambdaMetadata in state.fnMetadata and is consulted by
// hydrate before overwriting an existing fn.
//
// Most built-ins are locked — replacing hydrate, runCycle, get, set
// would break invariants. The formula compiler "f" is unlocked: it's
// a compile-time helper that hydrate looks up to turn cel.f source
// into cel._fn. Hosts swap formula languages by registering a
// replacement Fn at "f" (with a matching `.extractDeps`) via the fns
// parameter to hydrate.
//
// precompute is intentionally absent: hydrate calls it directly and
// it never enters the registry.
// ============================================================================

// Compiler-shaped fn: takes a formula source string and returns the
// runtime Fn that hydrate will store at cel._fn. The `extractDeps`
// property is consulted by hydrate to auto-wire cel.inputMap.
const formulaFn: Fn = (src: string) => compileFormula(src);
formulaFn.extractDeps = extractDeps;

export const coreFns: Map<LambdaKey, Fn> = new Map([
  ["get",       get],
  ["set",       set],
  ["batch",     batch],
  ["touch",     touch],
  ["consume",   consume],
  ["runCycle",  runCycle],
  ["hydrate",   hydrate],
  ["dehydrate", dehydrate],
  ["flush",     flush],
  ["f",         formulaFn],
]);

export const coreFnMetadata: Map<LambdaKey, LambdaMetadata> = new Map([
  ["get",       { key: "get",       locked: true  }],
  ["set",       { key: "set",       locked: true  }],
  ["batch",     { key: "batch",     locked: true  }],
  ["touch",     { key: "touch",     locked: true  }],
  ["consume",   { key: "consume",   locked: true  }],
  ["runCycle",  { key: "runCycle",  locked: true  }],
  ["hydrate",   { key: "hydrate",   locked: true  }],
  ["dehydrate", { key: "dehydrate", locked: true  }],
  ["flush",     { key: "flush",     locked: true  }],
  ["f",         { key: "f",         locked: false }],
]);
