import {
  openSqlite,
  ensureSchema,
  runMigrations,
} from "../../../../segments/plastron-sqlite/src/index.js";
import type { SqliteHandle } from "../../../../segments/plastron-sqlite/src/index.js";
import { cmsMigrations } from "./migrations.js";

// Open the CMS database. In a browser the path is OPFS-relative; in Node
// it would be a file path. Falls back to :memory: if OPFS isn't usable.
//
// The host pre-loads the sqlite-wasm module and passes it to openSqlite
// so that bundlers (Vite) include it in the build correctly.
export const openCmsDb = async (path = "/plastron-cms.sqlite"): Promise<SqliteHandle> => {
  // Vite-bundle-aware import. The wasm module is excluded from
  // optimizeDeps in vite.config.ts so its native .wasm asset is served
  // alongside the JS bundle.
  const sqliteModule = await import("@sqlite.org/sqlite-wasm");
  const db = await openSqlite({
    path,
    backend: { kind: "sqlite-wasm", module: sqliteModule },
  });
  await ensureSchema(db);                    // plastron_archives + meta tables
  const result = await runMigrations(db, cmsMigrations);
  if (result.drift.length > 0) {
    console.warn(
      "[cms] migration drift detected (someone edited a past migration):",
      result.drift,
    );
  }
  return db;
};
