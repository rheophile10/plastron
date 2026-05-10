import type { Key, SegmentManifest, State } from "../types/index.js";

// ============================================================================
// Segment introspection helpers + a small inline semver implementation.
//
// The helpers (getSegmentManifest, listSegments, findDependents) are
// registered as locked core fns so lambdas / host tooling can react to
// what's loaded without depending on the kernel module directly. They
// are sync, side-effect-free, and small.
//
// `satisfies(version, range)` covers the subset of npm semver grammar
// that real plastron deps use:
//
//   • "*"          — match any version
//   • exact        — "1.2.3"
//   • caret        — "^1.2.3"  → >=1.2.3 <2.0.0  (or for 0.x.y:
//                                                  >=0.x.y <0.(x+1).0,
//                                                  for 0.0.z: =0.0.z)
//   • tilde        — "~1.2.3"  → >=1.2.3 <1.3.0
//   • >= / > / <= / < / =       — single-comparator ranges
//
// Pre-release identifiers (-alpha, -rc.1, …) are accepted in the
// version string but compared as strings after the major/minor/patch
// triple matches; that's enough for "this is the same release line"
// checks. Any range form not listed above (compound `||`, hyphen,
// x-ranges like 1.2.x) returns `false`. Hosts that need those should
// pin exact or use a real semver library.
// ============================================================================

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
}

const parseVersion = (v: string): ParsedVersion | null => {
  // Accept "1", "1.2", or "1.2.3", with an optional pre/build suffix.
  // Missing components default to 0 — "^1.0" parses as 1.0.0 with the
  // same upper-bound as "^1.0.0" (i.e. <2.0.0).
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.+))?$/.exec(v.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: m[2] === undefined ? 0 : Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
    prerelease: m[4] ?? "",
  };
};

const cmp = (a: ParsedVersion, b: ParsedVersion): number => {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // Bare version (no prerelease) sorts higher than any prerelease.
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === "") return 1;
  if (b.prerelease === "") return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
};

const within = (
  ver: ParsedVersion,
  lo: ParsedVersion,
  hi: ParsedVersion,
): boolean => cmp(ver, lo) >= 0 && cmp(ver, hi) < 0;

export const satisfies = (version: string, range: string): boolean => {
  const r = range.trim();
  if (r === "*" || r === "") return true;

  const ver = parseVersion(version);
  if (!ver) return false;

  // Comparator ranges: >=, >, <=, <, =.
  const compMatch = /^(>=|<=|>|<|=)\s*(.+)$/.exec(r);
  if (compMatch) {
    const op = compMatch[1];
    const target = parseVersion(compMatch[2]);
    if (!target) return false;
    const c = cmp(ver, target);
    switch (op) {
      case ">":  return c >  0;
      case ">=": return c >= 0;
      case "<":  return c <  0;
      case "<=": return c <= 0;
      case "=":  return c === 0;
    }
  }

  if (r.startsWith("^")) {
    const target = parseVersion(r.slice(1));
    if (!target) return false;
    let hi: ParsedVersion;
    if (target.major > 0) {
      hi = { major: target.major + 1, minor: 0, patch: 0, prerelease: "" };
    } else if (target.minor > 0) {
      hi = { major: 0, minor: target.minor + 1, patch: 0, prerelease: "" };
    } else {
      hi = { major: 0, minor: 0, patch: target.patch + 1, prerelease: "" };
    }
    return within(ver, target, hi);
  }

  if (r.startsWith("~")) {
    const target = parseVersion(r.slice(1));
    if (!target) return false;
    const hi: ParsedVersion = {
      major: target.major, minor: target.minor + 1, patch: 0, prerelease: "",
    };
    return within(ver, target, hi);
  }

  // Bare version → exact match.
  const target = parseVersion(r);
  if (!target) return false;
  return cmp(ver, target) === 0;
};

// ============================================================================
// Introspection helpers — exposed via state.fns as locked core entries.
// ============================================================================

/** Return the manifest for a loaded segment, or undefined. */
export const getSegmentManifest = (
  state: State,
  key: Key,
): SegmentManifest | undefined => state.segments.get(key);

/** Return all loaded segment manifests, in load order
 *  (Map iteration is insertion-ordered in JS). */
export const listSegments = (state: State): SegmentManifest[] =>
  Array.from(state.segments.values());

/** Return the segments that declare segmentKey as a dependency. */
export const findDependents = (state: State, segmentKey: Key): Key[] => {
  const out: Key[] = [];
  for (const [k, m] of state.segments) {
    if (m.dependsOn?.some((d) => d.segment === segmentKey)) out.push(k);
  }
  return out;
};

/** Topological order of the transitive dependents of `segmentKey`,
 *  leaves first. Used by flush(..., { cascade: true }) to know which
 *  dependents to flush before the target. */
export const topologicalDependentOrder = (
  segments: Map<Key, SegmentManifest>,
  segmentKey: Key,
): Key[] => {
  // Reverse adjacency: dep → list of dependents.
  const dependentsOf = new Map<Key, Key[]>();
  for (const [k, m] of segments) {
    if (!m.dependsOn) continue;
    for (const d of m.dependsOn) {
      let bucket = dependentsOf.get(d.segment);
      if (!bucket) { bucket = []; dependentsOf.set(d.segment, bucket); }
      bucket.push(k);
    }
  }

  // BFS the transitive dependent set, then return in
  // dependents-first order via DFS post-order.
  const visited = new Set<Key>();
  const order: Key[] = [];
  const visit = (k: Key): void => {
    if (visited.has(k)) return;
    visited.add(k);
    for (const child of dependentsOf.get(k) ?? []) visit(child);
    if (k !== segmentKey) order.push(k);
  };
  visit(segmentKey);
  return order;
};
