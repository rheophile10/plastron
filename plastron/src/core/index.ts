import type { Fn, LambdaKey, LambdaMetadata } from "../types/index.js";
import { hydrate, dehydrate } from "./hydrate.js";
import { runCycle } from "./runCycle.js";
import {
  get, set, batch, touch, consume, drain,
  getCel, getCelBatch, setCel, setCelBatch, registerLambda,
} from "./input.js";
import { flush } from "./flush.js";
import { compileFormula, extractDeps } from "./formula.js";
import { findDependents, getSegmentManifest, listSegments } from "./segments.js";

// ============================================================================
// coreFns + coreFnMetadata — the default fn registry and the parallel
// metadata that drives lock policy. Both are derived from coreFnEntries
// below; createInitialState clones both into state.fns and state.fnMetadata.
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

interface CoreFnEntry {
  key: LambdaKey;
  fn: Fn;
  locked: boolean;
}

const coreFnEntries: ReadonlyArray<CoreFnEntry> = [
  { key: "get",            fn: get,            locked: true  },
  { key: "set",            fn: set,            locked: true  },
  { key: "batch",          fn: batch,          locked: true  },
  { key: "getCel",         fn: getCel,         locked: true  },
  { key: "setCel",         fn: setCel,         locked: true  },
  { key: "getCelBatch",    fn: getCelBatch,    locked: true  },
  { key: "setCelBatch",    fn: setCelBatch,    locked: true  },
  { key: "touch",          fn: touch,          locked: true  },
  { key: "consume",        fn: consume,        locked: true  },
  { key: "runCycle",       fn: runCycle,       locked: true  },
  { key: "hydrate",        fn: hydrate,        locked: true  },
  { key: "dehydrate",      fn: dehydrate,      locked: true  },
  { key: "flush",          fn: flush,          locked: true  },
  { key: "drain",          fn: drain,          locked: true  },
  { key: "registerLambda", fn: registerLambda, locked: true  },
  // Segment-manifest introspection. Sync, side-effect-free, locked
  // so segments can't shadow them.
  { key: "getSegmentManifest", fn: getSegmentManifest as Fn, locked: true  },
  { key: "listSegments",       fn: listSegments       as Fn, locked: true  },
  { key: "findDependents",     fn: findDependents     as Fn, locked: true  },
  { key: "f",              fn: formulaFn,      locked: false },
];

export const coreFns: Map<LambdaKey, Fn> = new Map(
  coreFnEntries.map((e) => [e.key, e.fn]),
);

export const coreFnMetadata: Map<LambdaKey, LambdaMetadata> = new Map(
  coreFnEntries.map((e) => [e.key, { key: e.key, locked: e.locked }]),
);
