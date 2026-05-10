import type { SegmentManifest } from "../../../plastron/src/index.js";

// ========================================================================
// segment: plastron-postgres
//
// Node-side host helper, not a runtime cel/lambda producer. The manifest
// is metadata-only: it advertises the segment and its dependency on
// plastron-archive, but it doesn't register lambdas, schemas, channels,
// or tag handlers. Hosts that load this package call the exported
// helpers (loadArchive / saveArchive / …) directly; nothing in the
// runtime graph touches state.fns or state.schemas because of this
// segment.
//
// celSegments is declared so a host that DOES want to mark cels with
// `segment: "plastron-postgres"` (e.g. a future config_postgres cel)
// flows through flush correctly. v1 ships none.
// ========================================================================

export const PLASTRON_POSTGRES_SEGMENT = "plastron-postgres" as const;

export const plastronPostgresManifest: SegmentManifest = {
  segment: PLASTRON_POSTGRES_SEGMENT,
  version: "0.0.1",
  description: "Node-side postgres adapter for plastron archives.",
  // semver "*": match any version. Kernel `satisfies` treats caret-on-
  // 0.0.x as exact-pin (`^0.0.0` only matches `0.0.0`), which would
  // wedge the moment plastron-archive bumps to `0.0.2`. Until we have
  // a stable plastron-archive surface to actually pin against, accept
  // any version present in the host.
  dependsOn: [{ segment: "plastron-archive", semver: "*" }],
  provides: { celSegments: [PLASTRON_POSTGRES_SEGMENT] },
};
