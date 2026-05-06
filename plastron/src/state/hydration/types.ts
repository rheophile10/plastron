import type { Key, varName, Provenance } from "../../common.js";
import type { LambdaKey, Fn, LambdaMetadata } from "../../lambdas/types/lambda.js";
import type { KindRegistry } from "../../lambdas/types/kind.js";
import type { HookSubscription } from "../cycle/hooks.js";
import type { SchemaKey } from "../../schemas/types/schema.js";
import type { SegmentMetadata, SegmentRegistry } from "../segments/types/segments.js";
import type { SegmentBundle } from "../segments/types/bundle.js";
import type { SegmentManifest, VerificationResult } from "../segments/types/manifest.js";
import type { TagRegistry } from "../types/tags.js";

// ========================================================================
// Dehydrated cel — the on-disk / JSON shape. Carries its segment key;
// hydration stamps it onto the live Cel and uses it to build the
// flushIndex cel.
// ========================================================================

export interface DehydratedCel extends Provenance {
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
  /** Lambda kind selector; see Cel.kind. Defaults to "native" when unset. */
  kind?:       string;
  inputMap?:   Record<varName, Key | Key[]>;
  /** Code-loading dependencies — module cels for polyglot kinds; see Cel.imports. */
  imports?:    Key[];
  f?:          string;
  /** Hint about the value's expected size; see Cel.sizeHint. */
  sizeHint?:   "small" | "large" | "stream";
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
  /** Formula-operator aliases to merge into the config_opAliases cel
   *  during hydrate. Lets segments contribute new symbols (and lambdas
   *  to bind them to) without runtime writes to the readOnly cel. */
  aliases?: Record<string, LambdaKey>;
  /** Per-segment metadata (role, loadByDefault, dependencies, manifest).
   *  Stored in the segmentRegistry reserved cel for downstream consumers
   *  (load-policy filters, audit logs, devtools). Pure data in this phase;
   *  filtering enforcement comes later. */
  segments?: Record<Key, SegmentMetadata>;
  /** Lambda kind handlers to register on the runtime. Merged into
   *  state._kinds at hydrate. The "native" handler is registered
   *  automatically during bootstrap; pass a key here only to override.
   *  Other kinds (formula, quickjs, python, sqlite, eshkol, …) come
   *  from extension packages. */
  kinds?: KindRegistry;
  /** Cycle hook subscribers. Each is an object whose keys are hook
   *  names. Multiple subscribers may register; all are observation-only.
   *  Errors are caught and logged. */
  hooks?: HookSubscription | HookSubscription[];
  /** Format-tagged value protocols to register. Merged into state._tags
   *  at hydrate. Each entry supplies comparator / release / serialize
   *  for opaque cel values bearing the corresponding tag. Untagged
   *  values fall through to default behaviour. */
  tags?: TagRegistry;
  /** Verifier invoked once per bundle that carries a manifest. Default
   *  (when absent) accepts everything. Real cryptography lives in the
   *  plastron-trust extension package; core only invokes the callback
   *  and refuses bundles whose verifier returns ok: false.
   *
   *  Only consulted by hydrateBundles / runtimeFromBundles — the
   *  legacy hydrate(cels, lambdas, fnRegistry) path bypasses verification
   *  because there is no manifest to verify. */
  verifySegment?: (
    bundle: SegmentBundle,
    manifest: SegmentManifest,
  ) => Promise<VerificationResult> | VerificationResult;
  /** When false, runtime() / plastron() / runtimeFromBundles skip
   *  installing the default segments (changeIndices, errors). Useful
   *  for minimal bundles where the host wants to wire only specific
   *  segments. The lower-level hydrate() always ignores this flag —
   *  it never installs defaults regardless. Default true. */
  installDefaults?: boolean;
}

export type { LambdaMetadata, SegmentMetadata, SegmentRegistry };
