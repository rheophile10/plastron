import type { Key, varName } from "../../common.js";
import type { LambdaKey, Fn, LambdaMetadata } from "../../lambdas/types/lambda.js";
import type { SchemaKey } from "../../schemas/types/schema.js";

// ========================================================================
// Dehydrated cel — the on-disk / JSON shape. Carries its segment key;
// hydration stamps it onto the live Cel and uses it to build the
// flushIndex cel.
// ========================================================================

export interface DehydratedCel {
  key:         Key;
  segment:     Key;
  v?:          unknown;
  children?:   Key[];
  tags?:       string[];
  schema?:     SchemaKey;
  name?:       string;
  description?:string;
  metadata?:   Record<string, unknown>;
  readOnly?:   boolean;
  l?:          LambdaKey;
  inputMap?:   Record<varName, Key | Key[]>;
  f?:          string;
  dynamic?:    boolean;
  wave?:       number;
  prevDepth?:  number;
}

/** Map from lambda key to the actual function implementation. Supplied
 *  alongside LambdaMetadata records so hydrate can pair them up. */
export type FnRegistry = Record<LambdaKey, Fn>;

export interface HydrateOptions {
  /** When true, colliding cel keys silently overwrite existing entries.
   *  When false (default), collisions throw. */
  upsert?: boolean;
}

export type { LambdaMetadata };
