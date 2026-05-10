import type { SegmentManifest } from "../../../plastron/src/index.js";

// ========================================================================
// segment: plastron-sqlite
//
// Host-side I/O helper. Same shape as plastron-postgres: the manifest
// advertises the segment + its dep on plastron-archive, but registers
// nothing in state.fns / state.schemas / state.channelRegistry. Hosts
// call openSqlite, ensureSchema, runMigrations, and the load/save
// helpers directly.
//
// celSegments is declared so a host that DOES want to mark cels with
// `segment: "plastron-sqlite"` (e.g. a config_sqlite cel) flows
// through flush correctly. v1 ships none.
// ========================================================================

export const PLASTRON_SQLITE_SEGMENT = "plastron-sqlite" as const;

export const plastronSqliteManifest: SegmentManifest = {
  segment: PLASTRON_SQLITE_SEGMENT,
  version: "0.0.1",
  description: "SQLite adapter for plastron archives — Node + browser, with migrations-as-segment.",
  // semver "*": same reasoning as plastron-postgres — caret-on-0.0.x
  // pins to exact in our `satisfies` implementation, which would wedge
  // the moment plastron-archive bumps. Until plastron-archive ships a
  // stable surface to pin against, accept any version.
  dependsOn: [{ segment: "plastron-archive", semver: "*" }],
  provides: { celSegments: [PLASTRON_SQLITE_SEGMENT] },
};
