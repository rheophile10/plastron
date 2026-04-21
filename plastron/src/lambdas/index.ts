import type { LambdaKey, Fn, LambdaMetadata } from "./types/lambda.js";
import { opsFns, opsMetadata } from "./metadata.js";
import { fFn, fMetadata } from "./formula/index.js";

// ========================================================================
// Default lambdas — operators + the formula evaluator `f`. Two parallel
// records: functions and metadata. Hydrate attaches the fn and metadata
// to each cel independently, so there's no combined "Lambda" type.
// ========================================================================

export const defaultFns: Record<LambdaKey, Fn> = {
  ...opsFns,
  f: fFn,
};

export const defaultMetadata: Record<LambdaKey, LambdaMetadata> = {
  ...opsMetadata,
  f: fMetadata,
};

// Re-exports for consumers
export { fFn, fMetadata, parseAndEval } from "./formula/index.js";
export { defaultAliases } from "./formula/aliases.js";
export { defaultSchemas } from "../schemas/index.js";
