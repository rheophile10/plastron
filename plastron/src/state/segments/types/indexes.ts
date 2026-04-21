import type { Key } from "../../../common.js";
import type { Cascade, WavedCascade } from "../../cycle/types.js";

// ========================================================================
// Precompute / hydrate outputs. Each is the .v shape of a reserved cel
// in segment "indexes".
// ========================================================================

/** Inverse lookup from tag string to cel keys. */
export type TagIndex = Record<string, Key[]>;

/** For each cel key, the WavedCascade that should fire when it's written. */
export type DownstreamTopology = Map<Key, WavedCascade>;

/** Layered cascade of dynamic (volatile) cels + their downstreams. */
export type DynamicCascade = Cascade;

/** Set of keys whose cels carry `dynamic: true`. */
export type DynamicKeys = Set<Key>;

/** For each segment, the cel keys that belong to it. */
export type SegmentCelsIndex = Map<Key, Set<Key>>;
