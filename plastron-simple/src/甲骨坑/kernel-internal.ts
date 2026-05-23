import type { Cel, CompiledLambda, Key, ValueCel } from "../types/index.js";
import { PRECOMPUTED_STATES_KEY, buildPrecomputedIndexes } from "../kernel/precompute/index.js";
import { ERRORS_LOG_KEY } from "./cel-error.js";
import type { CelError } from "./cel-error.js";

// Kernel-internal seeds. Locked ValueCels holding state-shaped caches
// the kernel keeps off the public type. Today:
//   • precomputedStates — cascade indexes (Maps + Sets JSON can't carry)
//   • compile.cache     — source-hash → CompiledLambda, per kind. Read
//                         by compileCelBody to skip re-compilation when
//                         a cel's source already compiled to a known
//                         envelope (hot-reload undo, cross-cel dedupe).
//                         Keyed `${kindKey}:${source}` so the same
//                         source under different compilers caches
//                         separately.
//   • errors            — append-only CelError[]. Every trap (compile,
//                         runtime, cycle, missing-compiler) pushes here
//                         in addition to landing on cel.v / throwing,
//                         so hosts can enumerate "what's broken" in O(1)
//                         and structural errors (cycles) have a home
//                         even when no single cel owns them.
//
// All v's are mutable containers. Each State needs its own — sharing
// across States leaks across independent kernels (matters for tests,
// multi-document apps). The `cels` export is a builder function
// evaluated once per createInitialState call.

export const COMPILE_CACHE_KEY: Key = "compile.cache";

export const name = "kernel" as const;

export const cels = (): Cel[] => [
  {
    celType: "ValueCel",
    metadata: { key: PRECOMPUTED_STATES_KEY, segment: "kernel" },
    v: buildPrecomputedIndexes(),
    locked: true,
  } satisfies ValueCel,
  {
    celType: "ValueCel",
    metadata: { key: COMPILE_CACHE_KEY, segment: "kernel" },
    v: new Map<string, Promise<CompiledLambda>>(),
    locked: true,
  } satisfies ValueCel,
  {
    celType: "ValueCel",
    metadata: { key: ERRORS_LOG_KEY, segment: "kernel" },
    v: [] as CelError[],
    locked: true,
  } satisfies ValueCel,
];
