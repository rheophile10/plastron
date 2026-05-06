import type { Key } from "../../../common.js";
import type { LambdaKey, LambdaMetadata } from "../../../lambdas/types/lambda.js";
import type { DehydratedCel } from "../../hydration/types.js";
import type { SegmentMetadata } from "./segments.js";
import type { SegmentManifest } from "./manifest.js";

// ========================================================================
// SegmentBundle — the canonical, JSON-serializable shape of a segment.
// This is what gets dumped, shared, and re-hydrated. Note that the
// runtime FnRegistry (real native-kind function references) is NOT part
// of the bundle — those ship as code with the host application. The
// bundle is the *data* portion; the runtime configures functions
// separately.
//
// For non-native kinds (formula, quickjs, python, sqlite, eshkol, …)
// the lambda source string lives in LambdaMetadata.source and travels
// inside the bundle.
// ========================================================================

/** Format version of the bundle envelope. Bumped on breaking format
 *  changes; readers refuse incompatible versions. */
export const BUNDLE_FORMAT_VERSION = 1 as const;

export interface SegmentBundle {
  /** Format version. Must equal BUNDLE_FORMAT_VERSION. */
  version: typeof BUNDLE_FORMAT_VERSION;
  /** Segment identity. Every cel in `cels` must have its `segment`
   *  field equal to this value. */
  key: Key;
  /** Per-cel definitions, keyed by cel key. */
  cels: Record<Key, DehydratedCel>;
  /** Lambda metadata for any lambdas this segment defines. For
   *  non-native kinds, includes `source` and `kind`. */
  lambdas?: Record<LambdaKey, LambdaMetadata>;
  /** Operator aliases this segment contributes (formula DSL extension). */
  aliases?: Record<string, LambdaKey>;
  /** Segment-level metadata — role, loadByDefault, dependencies, etc.
   *  The `key` field on SegmentMetadata is redundant here (it equals
   *  bundle.key) and is omitted. */
  metadata?: Omit<SegmentMetadata, "key">;
  /** Optional cryptographic manifest. When present, verifySegment is
   *  consulted at hydrate. */
  manifest?: SegmentManifest;
}
