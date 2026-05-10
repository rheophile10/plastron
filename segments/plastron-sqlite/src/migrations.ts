// ========================================================================
// Migrations as a segment — walk a `"migrations"`-shaped Segment whose
// cels carry CREATE TABLE / ALTER TABLE / CREATE INDEX statements,
// apply them in key-sort order, and record what was applied in a meta
// table so re-runs are idempotent.
//
// Two cel value shapes accepted:
//   • cel.v: string                       — single SQL statement (no rollback)
//   • cel.v: { up: string; down?: string } — explicit up; down is recorded
//                                              for tooling, never auto-run
//
// Sort order is lexicographic on cel.key. Convention: prefix with a
// zero-padded sequence (`001_users`, `002_users_index`, …) so naïve
// sort matches intent.
//
// Idempotency model: we hash the SQL (SHA-256, falling back to FNV-1a
// when subtle isn't available) and store the hash alongside the cel
// key. On re-run:
//   • applied + hash matches    → skip
//   • applied + hash mismatches → drift (don't re-run; surface to caller)
//   • not applied               → run inside a transaction, record on success
// ========================================================================

import type { Key, Segment } from "../../../plastron/src/index.js";
import type { SqliteHandle } from "./sqlite-types.js";

const MIGRATIONS_TABLE = "_plastron_migrations";

export interface RunMigrationsResult {
  /** Cel keys whose migrations were applied this run. */
  applied: Key[];
  /** Cel keys already in the meta table whose hash matched. */
  skipped: Key[];
  /** Cel keys with a recorded hash that doesn't match the current SQL.
   *  These are NOT re-run. The caller decides — usually this means a
   *  past migration was edited after being applied, which is dangerous
   *  in any RDBMS. */
  drift: Array<{ key: Key; recordedHash: string; currentHash: string }>;
}

const ensureMigrationsTable = async (db: SqliteHandle): Promise<void> => {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
       cel_key    TEXT PRIMARY KEY,
       sql_hash   TEXT NOT NULL,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
};

const extractSql = (v: unknown, key: Key): string => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "up" in v) {
    const up = (v as { up: unknown }).up;
    if (typeof up === "string") return up;
  }
  throw new Error(
    `plastron-sqlite.runMigrations: cel "${key}" has unsupported v ` +
    `(want string or { up: string }); got ${typeof v}.`,
  );
};

// SHA-256 via SubtleCrypto where available (browsers, modern Node 19+),
// FNV-1a as a portable fallback. Hash is for drift detection — not
// cryptographic — so the fallback is fine.
const hashSql = async (sql: string): Promise<string> => {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle) {
    const data = new TextEncoder().encode(sql);
    const buf = await subtle.digest("SHA-256", data);
    const arr = new Uint8Array(buf);
    let out = "";
    for (let i = 0; i < arr.length; i++) {
      out += arr[i]!.toString(16).padStart(2, "0");
    }
    return `sha256:${out}`;
  }
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < sql.length; i++) {
    h ^= sql.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fnv1a:${(h >>> 0).toString(16).padStart(8, "0")}`;
};

export const runMigrations = async (
  db: SqliteHandle,
  segment: Pick<Segment, "cels">,
): Promise<RunMigrationsResult> => {
  await ensureMigrationsTable(db);

  // What's already applied?
  const appliedRows = await db.all<{ cel_key: string; sql_hash: string }>(
    `SELECT cel_key, sql_hash FROM ${MIGRATIONS_TABLE}`,
  );
  const appliedMap = new Map<string, string>();
  for (const r of appliedRows) appliedMap.set(r.cel_key, r.sql_hash);

  // Sort cels by key. The kernel doesn't guarantee an order; we provide
  // one so users can rely on sequential prefixes.
  const cels = [...segment.cels].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const applied: Key[] = [];
  const skipped: Key[] = [];
  const drift: Array<{ key: Key; recordedHash: string; currentHash: string }> = [];

  for (const cel of cels) {
    const sql = extractSql(cel.v, cel.key);
    const currentHash = await hashSql(sql);
    const recordedHash = appliedMap.get(cel.key);

    if (recordedHash !== undefined) {
      if (recordedHash === currentHash) {
        skipped.push(cel.key);
      } else {
        drift.push({ key: cel.key, recordedHash, currentHash });
      }
      continue;
    }

    // Not applied — run inside a transaction, record on success. If
    // the migration SQL throws, the transaction rolls back and the
    // meta-table insert never happens.
    await db.transaction(async (h) => {
      await h.exec(sql);
      await h.run(
        `INSERT INTO ${MIGRATIONS_TABLE} (cel_key, sql_hash) VALUES (?, ?)`,
        [cel.key, currentHash],
      );
    });
    applied.push(cel.key);
  }

  return { applied, skipped, drift };
};
