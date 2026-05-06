import type { Key, Provenance } from "../../../common.js";

// ========================================================================
// Segment-level metadata. One entry per segment key. Stored in the
// reserved `segmentRegistry` cel after hydrate. Consumers — load-policy
// filters, audit-log writers, devtools panels, segment-share UIs —
// inspect this registry rather than hunting for cels by segment field.
//
// All fields are optional. Documents that don't carry segment metadata
// behave exactly as today (every segment loads, no role distinction).
// ========================================================================

/** Role declares what this segment is for. Drives load-policy filters
 *  (production builds skip "test" / "metadata" / "documentation" /
 *  "devtools" segments by default). "system" is reserved for runtime-
 *  owned segments (config, indexes, state, input). */
export type SegmentRole =
  | "code"
  | "schema"
  | "test"
  | "metadata"
  | "documentation"
  | "devtools"
  | "system";

export interface SegmentMetadata extends Provenance {
  key: Key;
  role?: SegmentRole;
  /** When false, this segment is skipped by default load-policy filters
   *  and must be explicitly requested. Defaults to true when unset. */
  loadByDefault?: boolean;
  /** Other segment keys this segment depends on. Hydration may use this
   *  to surface "missing dependency" errors when a referenced segment is
   *  filtered out by load policy. */
  dependsOnSegments?: Key[];
  /** Free-form description for humans. */
  description?: string;
  /** Optional load-time configuration values declared by the author.
   *  Distinct from runtime-set cel values — this is *what the segment
   *  was loaded with*, captured for fingerprint and audit purposes. */
  loadConfig?: Record<string, unknown>;
}

/** Stored in the reserved `segmentRegistry` cel as a Record. */
export type SegmentRegistry = Record<Key, SegmentMetadata>;
