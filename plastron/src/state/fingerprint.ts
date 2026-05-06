import type { Key } from "../common.js";
import type { State } from "./types/index.js";
import type { HookName } from "./cycle/hooks.js";
import type { SegmentRegistry, SegmentRole } from "./segments/types/index.js";
import { canonicalize, sha256Hex } from "./segments/serialization.js";

// ========================================================================
// Runtime fingerprint
//
// Deterministic content-addressed identifier for "this exact runtime,
// with this exact set of loaded segments, in this exact configuration."
// Two runtimes with the same fingerprint have, by construction, the same
// engine version, the same kinds and hook subscribers, and the same
// segments loaded; they behave identically modulo runtime data.
//
// Excludes:
//   • document state (cel values change every cycle)
//   • session UUIDs (orthogonal to composition)
//   • runtime-set cel values (versus segment-manifest loadConfig)
// ========================================================================

/** Engine version baked into the build. Bumped on releases. Included
 *  in the fingerprint so dev and prod runtimes can be distinguished. */
export const ENGINE_VERSION = "0.0.1";

export interface FingerprintComponents {
  engineVersion: string;
  /** Registered lambda-kind keys, sorted. */
  kinds: string[];
  /** Hook points with at least one subscriber, sorted. Coarse view —
   *  doesn't identify individual subscribers. */
  hooks: HookName[];
  /** Loaded segments, sorted by key. Captures key + role. */
  segments: Array<{ key: Key; role?: SegmentRole }>;
  /** Format-tag protocols registered, sorted by tag. */
  tags: string[];
  /** Trust policy identifier set by an extension package (e.g.
   *  plastron-trust), null when no verifier policy is in effect. */
  trustPolicy: string | null;
}

const HOOK_NAMES: HookName[] = [
  "beforeCycle", "afterLambdaInvoke", "afterWave", "afterCycle", "afterHydrate",
];

export const fingerprintComponents = (state: State): FingerprintComponents => {
  const kinds = Object.keys(state._kinds ?? {}).sort();

  // Coarse: which hook points have at least one subscriber.
  const subs = state._hooks ?? [];
  const hookSet = new Set<HookName>();
  for (const sub of subs) {
    for (const name of HOOK_NAMES) {
      if (sub[name]) hookSet.add(name);
    }
  }
  const hooks = Array.from(hookSet).sort();

  const registry = (state.Cels.get("segmentRegistry")?.v ?? {}) as SegmentRegistry;
  const segments = Object.values(registry)
    .map((m) => {
      const entry: { key: Key; role?: SegmentRole } = { key: m.key };
      if (m.role !== undefined) entry.role = m.role;
      return entry;
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  const tags = Object.keys(state._tags ?? {}).sort();

  return {
    engineVersion: ENGINE_VERSION,
    kinds,
    hooks,
    segments,
    tags,
    trustPolicy: state._trustPolicy ?? null,
  };
};

/** sha256 hex over the canonicalized fingerprint components. */
export const fingerprint = async (state: State): Promise<string> => {
  const components = fingerprintComponents(state);
  return await sha256Hex(canonicalize(components));
};
