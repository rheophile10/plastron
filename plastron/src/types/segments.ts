// ============================================================================
// SegmentManifest — declared dependencies, version, and what each
// segment installs into shared kernel registries. Optional on every
// Segment: a Segment with no manifest hydrates exactly as it did
// before this layer existed (no entry in state.segments, no
// dependency check).
//
// Reserved segment keys (convention, enforced only by code review):
//
//   "core"   — kernel-internal seed cels. Created by createInitialState.
//              Locked, never flushed.
//
//   "config" — configuration cels. Each plastron-* package adds a
//              `config_<feature>` cel here at install (e.g.
//              config_performance, config_gpu, config_collections).
//              Lambdas read these cels to gate behavior. Hosts mutate
//              them via input.set to change runtime config.
//
//   "stats"  — observation cels written by the kernel for telemetry.
//              See task-perf-tracking.md. Filtered out at dehydrate.
//
//   "default" — fallback segment for cels with no `segment` field set.
//
// Package-owned segments use the package name (e.g. "plastron-dom",
// "plastron-collections", "plastron-gpu"). Cels they place in
// "config" or "stats" must have keys prefixed with the package's
// short name (e.g. config_gpu, stats_collections) so flush can
// tell them apart.
// ============================================================================

import type { Key } from "./index.js";
import type { ChannelKey } from "./channels.js";
import type { LambdaKey } from "./lambdas.js";
import type { SchemaKey } from "./schemas.js";
import type { TagKey } from "./tags.js";

export interface SegmentDependency {
  /** Required segment's key. Must match a Segment.key in some
   *  already-loaded segment by the time this segment hydrates. */
  segment: Key;
  /** Optional semver range. When present, the loaded segment's
   *  manifest.version must satisfy this range. Omitted = any version. */
  semver?: string;
  /** When true, hydrate refuses if the dependency is missing or
   *  out of range. When false, hydrate logs a warning and proceeds.
   *  Default: true. */
  required?: boolean;
}

export interface SegmentProvides {
  /** Lambda keys this segment registers in state.fns. Used by
   *  flush to detect dependent segments at teardown. */
  lambdas?: LambdaKey[];
  /** Schema keys this segment registers in state.schemas. */
  schemas?: SchemaKey[];
  /** Tag keys this segment registers in state.tagRegistry. */
  tags?: TagKey[];
  /** Channel keys this segment registers in state.channelRegistry.
   *  Channels are typically host-installed; declare here only when
   *  the segment owns the registration. */
  channels?: ChannelKey[];
  /** cel.segment values this segment owns. Usually [Segment.key],
   *  but a package that places cels in shared segments (e.g. "config",
   *  "stats") declares those here too. Used by flush to know whether
   *  to remove cels from shared segments when this segment unloads. */
  celSegments?: Key[];
}

export interface SegmentManifest {
  /** Same as Segment.key. Stored on the manifest for convenience —
   *  state.segments is keyed by this. */
  segment: Key;
  /** Semver-shaped version string. Used for dependency satisfaction
   *  and for "what's loaded" reproducibility. */
  version: string;
  /** Human-readable description. Optional, surfaces in tooling. */
  description?: string;
  /** Other segments this one needs. Validated at hydrate. */
  dependsOn?: SegmentDependency[];
  /** What this segment installs into shared kernel registries.
   *  Used at flush to detect dependents. */
  provides?: SegmentProvides;
}
