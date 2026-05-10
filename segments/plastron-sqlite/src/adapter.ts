// ========================================================================
// SQLite archive adapter — mirrors plastron-postgres's surface so hosts
// can swap backends with one import change.
//
// One row per project. The row holds the entire `.甲` zip blob in a
// `BLOB` column, plus an optional JSON-encoded metadata sidecar.
// Everything State-shaped lives in plastron-archive (importArchive /
// exportArchive); this is a thin transport layer.
//
// Defaults (overridable per-call via SqliteArchiveOpts):
//   table          plastron_archives
//   keyColumn      id          TEXT PRIMARY KEY
//   bytesColumn    archive     BLOB NOT NULL
//   metadataColumn metadata    TEXT (JSON, nullable)
//
// ensureSchema also creates `created_at` / `updated_at` TEXT columns
// defaulted to `datetime('now')` so listArchives can return them. As
// with the postgres adapter, those names are not configurable; hosts
// that need to override them should manage their own migrations and
// skip ensureSchema.
// ========================================================================

import type { Segment, State, Fn } from "../../../plastron/src/index.js";
import {
  exportArchive,
  importArchive,
} from "../../plastron-archive/src/index.js";
import type { SqliteHandle } from "./sqlite-types.js";

export interface SqliteArchiveOpts {
  /** Table holding archive blobs. Default `"plastron_archives"`. */
  table?: string;
  /** Primary-key column (TEXT). Default `"id"`. */
  keyColumn?: string;
  /** BLOB column carrying the `.甲` bytes. Default `"archive"`. */
  bytesColumn?: string;
  /** TEXT column for JSON-encoded host-supplied metadata. Default `"metadata"`. */
  metadataColumn?: string;
}

interface ResolvedOpts {
  table: string;
  keyColumn: string;
  bytesColumn: string;
  metadataColumn: string;
}

const resolveOpts = (opts?: SqliteArchiveOpts): ResolvedOpts => ({
  table:          opts?.table          ?? "plastron_archives",
  keyColumn:      opts?.keyColumn      ?? "id",
  bytesColumn:    opts?.bytesColumn    ?? "archive",
  metadataColumn: opts?.metadataColumn ?? "metadata",
});

// SQLite identifiers can't be parameterized via `?`. Restrict them to
// the safe shape (letters, digits, underscores; must start with letter
// or _) and double-quote them. Same approach as plastron-postgres.
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ident = (name: string): string => {
  if (!SAFE_IDENT.test(name)) {
    throw new Error(
      `plastron-sqlite: identifier ${JSON.stringify(name)} is not safe ` +
      `to interpolate. Use [A-Za-z_][A-Za-z0-9_]*.`,
    );
  }
  return `"${name}"`;
};

export const ensureSchema = async (
  db: SqliteHandle,
  opts?: SqliteArchiveOpts,
): Promise<void> => {
  const o = resolveOpts(opts);
  const t = ident(o.table);
  const k = ident(o.keyColumn);
  const b = ident(o.bytesColumn);
  const m = ident(o.metadataColumn);
  // CREATE IF NOT EXISTS — idempotent. Real migrations live in the
  // host's migrations segment; this is just enough to bootstrap.
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${t} (
       ${k}  TEXT PRIMARY KEY,
       ${b}  BLOB NOT NULL,
       ${m}  TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
};

export interface LoadedArchive {
  segments: Segment[];
  metadata?: unknown;
}

export const loadArchive = async (
  db: SqliteHandle,
  key: string,
  opts?: SqliteArchiveOpts,
): Promise<LoadedArchive | null> => {
  const o = resolveOpts(opts);
  const t = ident(o.table);
  const k = ident(o.keyColumn);
  const b = ident(o.bytesColumn);
  const m = ident(o.metadataColumn);
  const row = await db.get<{ archive: unknown; metadata: unknown }>(
    `SELECT ${b} AS archive, ${m} AS metadata FROM ${t} WHERE ${k} = ? LIMIT 1`,
    [key],
  );
  if (!row) return null;
  const bytes = toBytes(row.archive);
  const result = await importArchive(bytes);
  // Close the live xit handle — the host doesn't need it for the
  // load/save round-trip. Power users who want a live archive can
  // call importArchive themselves on bytes pulled from a separate get.
  await result.archive.close();
  const out: LoadedArchive = { segments: result.segments };
  if (row.metadata !== null && row.metadata !== undefined) {
    out.metadata = parseJsonMetadata(row.metadata);
  }
  return out;
};

export interface SaveArchiveOpts extends SqliteArchiveOpts {
  /** Forwarded to `exportArchive`. Optional commit message. */
  message?: string;
  /** Forwarded to `exportArchive`. `"Name <email>"`. */
  author?: string;
  /** When true, fetch the existing row's bytes first and pass them as
   *  `previous` to `exportArchive` so the new commit lands on top of
   *  history. Default `true` — losing history silently on every save
   *  is the wrong default. */
  preserveHistory?: boolean;
}

/**
 * Persist `state` as a `.甲` archive blob under `key`.
 *
 * Metadata semantics mirror plastron-postgres:
 *   - `undefined` preserves any previously-stored metadata (the UPDATE
 *     branch uses `COALESCE` so the existing column value wins when
 *     the new value is null).
 *   - Explicit `null` is currently equivalent to `undefined` because
 *     `metadata ?? null` normalizes both to a SQL NULL parameter. To
 *     truly clear stored metadata, pass an empty object `{}`.
 *   - Pass an object/array/scalar to overwrite. JSON-encoded into the
 *     metadata column.
 */
export const saveArchive = async (
  db: SqliteHandle,
  key: string,
  state: State,
  metadata?: unknown,
  opts?: SaveArchiveOpts,
): Promise<void> => {
  const o = resolveOpts(opts);
  const t = ident(o.table);
  const k = ident(o.keyColumn);
  const b = ident(o.bytesColumn);
  const m = ident(o.metadataColumn);

  const dehydrate = state.fns.get("dehydrate") as Fn | undefined;
  if (!dehydrate) {
    throw new Error(
      `plastron-sqlite.saveArchive: state.fns has no "dehydrate". ` +
      `Did you create the state via createInitialState()?`,
    );
  }
  const segments = dehydrate(state) as Segment[];

  // Pull previous blob (if any) for history-preserving xit commits.
  let previous: Uint8Array | undefined;
  if (opts?.preserveHistory !== false) {
    const prev = await db.get<{ archive: unknown }>(
      `SELECT ${b} AS archive FROM ${t} WHERE ${k} = ? LIMIT 1`,
      [key],
    );
    if (prev) previous = toBytes(prev.archive);
  }

  const bytes = await exportArchive(segments, {
    ...(previous !== undefined ? { previous } : {}),
    ...(opts?.message !== undefined ? { message: opts.message } : {}),
    ...(opts?.author  !== undefined ? { author:  opts.author  } : {}),
  });

  // SQLite UPSERT — `ON CONFLICT(pk) DO UPDATE`. COALESCE on the
  // metadata branch so an undefined-metadata save preserves whatever
  // was there. First-time INSERTs still write NULL because there's
  // nothing to coalesce against. To clear metadata on an existing row,
  // see the saveArchive doc comment.
  const metaParam = metadata === undefined || metadata === null
    ? null
    : JSON.stringify(metadata);
  await db.run(
    `INSERT INTO ${t} (${k}, ${b}, ${m}, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(${k}) DO UPDATE SET
       ${b} = excluded.${b},
       ${m} = COALESCE(excluded.${m}, ${t}.${m}),
       updated_at = datetime('now')`,
    [key, bytes, metaParam],
  );
};

export interface ArchiveListing {
  key: string;
  metadata?: unknown;
  createdAt: string;
  updatedAt: string;
}

export const listArchives = async (
  db: SqliteHandle,
  opts?: SqliteArchiveOpts,
): Promise<ArchiveListing[]> => {
  const o = resolveOpts(opts);
  const t = ident(o.table);
  const k = ident(o.keyColumn);
  const m = ident(o.metadataColumn);
  const rows = await db.all<{
    key: string;
    metadata: unknown;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT ${k} AS key, ${m} AS metadata, created_at, updated_at
       FROM ${t}
       ORDER BY ${k}`,
  );
  return rows.map((row) => {
    const entry: ArchiveListing = {
      key: row.key,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
    if (row.metadata !== null && row.metadata !== undefined) {
      entry.metadata = parseJsonMetadata(row.metadata);
    }
    return entry;
  });
};

export const deleteArchive = async (
  db: SqliteHandle,
  key: string,
  opts?: SqliteArchiveOpts,
): Promise<boolean> => {
  const o = resolveOpts(opts);
  const t = ident(o.table);
  const k = ident(o.keyColumn);
  // SQLite has no native rowCount-after-DELETE outside changes(); query
  // it as a follow-up scalar. Cheap.
  const before = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${t} WHERE ${k} = ?`,
    [key],
  );
  if (!before || before.n === 0) return false;
  await db.run(`DELETE FROM ${t} WHERE ${k} = ?`, [key]);
  return true;
};

// ───────────────────────────── helpers ──────────────────────────────

// Both backends decode BLOB columns to byte-shaped values, but the
// concrete type varies:
//   • better-sqlite3 hands back a Buffer (Uint8Array subclass)
//   • sqlite-wasm hands back a Uint8Array
//   • a future driver could hand back ArrayBuffer
// Normalize defensively so adapter.ts can keep its hands clean.
const toBytes = (raw: unknown): Uint8Array => {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  throw new Error(
    `plastron-sqlite: expected BLOB column to decode as Uint8Array; ` +
    `got ${typeof raw}.`,
  );
};

const parseJsonMetadata = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw;  // already structured
  try { return JSON.parse(raw); } catch { return raw; }
};

const toIso = (v: string): string => {
  // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" UTC. Re-parse
  // so callers always see ISO-8601 with the trailing Z.
  const d = new Date(v.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toISOString();
};
