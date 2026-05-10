export { openSqlite } from "./open.js";
export type { OpenSqliteOptions } from "./open.js";

export {
  ensureSchema,
  loadArchive,
  saveArchive,
  listArchives,
  deleteArchive,
} from "./adapter.js";
export type {
  SqliteArchiveOpts,
  SaveArchiveOpts,
  LoadedArchive,
  ArchiveListing,
} from "./adapter.js";

export { runMigrations } from "./migrations.js";
export type { RunMigrationsResult } from "./migrations.js";

export type { SqliteHandle, SqliteRow } from "./sqlite-types.js";

export {
  PLASTRON_SQLITE_SEGMENT,
  plastronSqliteManifest,
} from "./manifest.js";
