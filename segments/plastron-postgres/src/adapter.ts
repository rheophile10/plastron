// ========================================================================
// Postgres archive adapter.
//
// One row per project. The row holds the entire `.甲` zip blob in a
// `bytea` column, plus an optional `jsonb` metadata sidecar (project
// name, last-author, whatever the host wants to filter/list by without
// having to crack open the zip). The adapter is a thin transport layer:
// segments → bytes is `exportArchive`; bytes → segments is
// `importArchive`. Everything State-shaped lives there, not here.
//
// Calling convention: the host passes its own `pg.Pool` or `pg.Client`
// (typed structurally as PgQueryable). We never instantiate a pool —
// that's the host's job, both for connection-management hygiene and so
// transactions, retries, and lifecycle are all owned in one place.
//
// Defaults (overridable per-call via PgArchiveOpts):
//   table          plastron_archives
//   keyColumn      id          text PRIMARY KEY
//   bytesColumn    archive     bytea NOT NULL
//   metadataColumn metadata    jsonb (nullable)
//
// ensureSchema also creates `created_at` / `updated_at timestamptz
// DEFAULT now()` columns so listArchives can return them. These names
// are not configurable in v1 — the moment a host needs to override
// them, they should be running their own migrations and skipping
// ensureSchema entirely.
// ========================================================================

import type { Segment, State, Fn } from "../../../plastron/src/index.js";
import {
  exportArchive,
  importArchive,
} from "../../plastron-archive/src/index.js";
import type { PgQueryable } from "./pg-types.js";

export interface PgArchiveOpts {
  /** Table holding archive blobs. Default `"plastron_archives"`. */
  table?: string;
  /** Primary-key column (text). Default `"id"`. */
  keyColumn?: string;
  /** `bytea` column carrying the `.甲` bytes. Default `"archive"`. */
  bytesColumn?: string;
  /** `jsonb` column for host-supplied metadata. Default `"metadata"`. */
  metadataColumn?: string;
}

interface ResolvedOpts {
  table: string;
  keyColumn: string;
  bytesColumn: string;
  metadataColumn: string;
}

const resolveOpts = (opts?: PgArchiveOpts): ResolvedOpts => ({
  table:          opts?.table          ?? "plastron_archives",
  keyColumn:      opts?.keyColumn      ?? "id",
  bytesColumn:    opts?.bytesColumn    ?? "archive",
  metadataColumn: opts?.metadataColumn ?? "metadata",
});

// Postgres identifiers can't be parameterized via `$1`, so the table
// and column names get interpolated. We restrict them to the safe
// shape (letters, digits, underscores; must start with letter or _),
// quote them with double-quotes, and reject anything else. This is
// the standard pg-client pattern for unparameterizable identifiers.
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ident = (name: string): string => {
  if (!SAFE_IDENT.test(name)) {
    throw new Error(
      `plastron-postgres: identifier ${JSON.stringify(name)} is not safe ` +
      `to interpolate. Use [A-Za-z_][A-Za-z0-9_]*.`,
    );
  }
  return `"${name}"`;
};

export const ensureSchema = async (
  client: PgQueryable,
  opts?: PgArchiveOpts,
): Promise<void> => {
  const o = resolveOpts(opts);
  const t = ident(o.table);
  const k = ident(o.keyColumn);
  const b = ident(o.bytesColumn);
  const m = ident(o.metadataColumn);
  // CREATE IF NOT EXISTS — idempotent, safe to call at boot. Real
  // schema migrations (renames, type changes, indexes beyond the PK)
  // are the host's job; this is just enough to get a fresh database
  // up and running.
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${t} (
       ${k}  text PRIMARY KEY,
       ${b}  bytea NOT NULL,
       ${m}  jsonb,
       created_at timestamptz NOT NULL DEFAULT now(),
       updated_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
};

export interface LoadedArchive {
  segments: Segment[];
  metadata?: unknown;
}

export const loadArchive = async (
  client: PgQueryable,
  key: string,
  opts?: PgArchiveOpts,
): Promise<LoadedArchive | null> => {
  const o = resolveOpts(opts);
  const t = ident(o.table);
  const k = ident(o.keyColumn);
  const b = ident(o.bytesColumn);
  const m = ident(o.metadataColumn);
  const res = await client.query<{ archive: unknown; metadata: unknown }>(
    `SELECT ${b} AS archive, ${m} AS metadata FROM ${t} WHERE ${k} = $1 LIMIT 1`,
    [key],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0]!;
  const bytes = toBytes(row.archive);
  const result = await importArchive(bytes);
  // Close the live xit handle — the host doesn't need it for the
  // load/save round-trip. Power users who want a live archive should
  // call `importArchive` themselves on bytes pulled out of a separate
  // query.
  await result.archive.close();
  const out: LoadedArchive = { segments: result.segments };
  if (row.metadata !== null && row.metadata !== undefined) {
    out.metadata = row.metadata;
  }
  return out;
};

export interface SaveArchiveOpts extends PgArchiveOpts {
  /** Forwarded to `exportArchive`. Optional commit message. */
  message?: string;
  /** Forwarded to `exportArchive`. `"Name <email>"`. */
  author?: string;
  /** When true, fetch the existing row's bytes first and pass them as
   *  `previous` to `exportArchive` so the new commit lands on top of
   *  history. Default `true` — losing history silently on every save
   *  is the wrong default. Pass `false` for a fresh repo per save. */
  preserveHistory?: boolean;
}

/**
 * Persist `state` as a `.甲` archive blob under `key`.
 *
 * Metadata semantics:
 *   - Passing `undefined` metadata preserves any previously-stored
 *     metadata for this key (the UPDATE branch uses `COALESCE` so the
 *     existing column value wins when the new value is null).
 *   - Pass explicit `null` to clear stored metadata. (Currently
 *     indistinguishable from `undefined` because `metadata ?? null`
 *     normalizes both to a SQL NULL parameter; if you need a true
 *     "clear" semantic, supply an empty object `{}` or write your own
 *     UPDATE statement.)
 *   - Pass an object/array/scalar to overwrite the stored value.
 */
export const saveArchive = async (
  client: PgQueryable,
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
      `plastron-postgres.saveArchive: state.fns has no "dehydrate". ` +
      `Did you create the state via createInitialState()?`,
    );
  }
  const segments = dehydrate(state) as Segment[];

  // History preservation: pull the previous blob (if any) and feed it
  // to exportArchive so the new export becomes the next commit on top.
  // This is a separate SELECT — could be folded into the UPSERT with
  // a CTE, but two round-trips keep the SQL legible and the bytea
  // payload only crosses the wire when we actually need it.
  let previous: Uint8Array | undefined;
  if (opts?.preserveHistory !== false) {
    const prev = await client.query<{ archive: unknown }>(
      `SELECT ${b} AS archive FROM ${t} WHERE ${k} = $1 LIMIT 1`,
      [key],
    );
    if (prev.rows.length > 0) {
      previous = toBytes(prev.rows[0]!.archive);
    }
  }

  const bytes = await exportArchive(segments, {
    ...(previous !== undefined ? { previous } : {}),
    ...(opts?.message !== undefined ? { message: opts.message } : {}),
    ...(opts?.author  !== undefined ? { author:  opts.author  } : {}),
  });

  // The pg driver accepts a `Buffer` for bytea inputs. We pass the
  // Uint8Array view directly; pg handles `Uint8Array` since 8.x by
  // forwarding to its bytea encoder. Wrap in `Buffer.from` only if
  // a host driver complains (matches plastron-archive's policy of
  // staying close to the bytes the libraries return).
  // Metadata `COALESCE` on UPDATE: when the caller omits metadata
  // (parameter binds as SQL NULL), keep whatever the row already had
  // rather than silently nuking it. First-time INSERTs still write
  // NULL because there's nothing to coalesce against — that's correct.
  // To clear metadata on an existing row, the caller has to write
  // their own UPDATE; see the saveArchive doc comment.
  await client.query(
    `INSERT INTO ${t} (${k}, ${b}, ${m}, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (${k}) DO UPDATE
       SET ${b} = EXCLUDED.${b},
           ${m} = COALESCE(EXCLUDED.${m}, ${t}.${m}),
           updated_at = now()`,
    [key, bytes, metadata ?? null],
  );
};

export interface ArchiveListing {
  key: string;
  metadata?: unknown;
  createdAt: string;
  updatedAt: string;
}

export const listArchives = async (
  client: PgQueryable,
  opts?: PgArchiveOpts,
): Promise<ArchiveListing[]> => {
  const o = resolveOpts(opts);
  const t = ident(o.table);
  const k = ident(o.keyColumn);
  const m = ident(o.metadataColumn);
  const res = await client.query<{
    key: string;
    metadata: unknown;
    created_at: Date | string;
    updated_at: Date | string;
  }>(
    `SELECT ${k} AS key, ${m} AS metadata, created_at, updated_at
       FROM ${t}
       ORDER BY ${k}`,
  );
  return res.rows.map((row) => {
    const entry: ArchiveListing = {
      key: row.key,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
    if (row.metadata !== null && row.metadata !== undefined) {
      entry.metadata = row.metadata;
    }
    return entry;
  });
};

export const deleteArchive = async (
  client: PgQueryable,
  key: string,
  opts?: PgArchiveOpts,
): Promise<boolean> => {
  const o = resolveOpts(opts);
  const t = ident(o.table);
  const k = ident(o.keyColumn);
  const res = await client.query(
    `DELETE FROM ${t} WHERE ${k} = $1`,
    [key],
  );
  // pg returns rowCount as number | null; null happens for statements
  // that don't return one (e.g. notifications). DELETE always sets it.
  return (res.rowCount ?? 0) > 0;
};

// ───────────────────────────── helpers ──────────────────────────────

// pg returns `bytea` columns as Node `Buffer` (which is a Uint8Array
// subclass), but a custom type-parser, a streaming driver, or some
// future pg version could hand back a plain Uint8Array, an ArrayBuffer,
// or even a hex string ("\\x...") if `bytea_output = 'hex'` is in play
// and parsers are disabled. Normalize defensively.
const toBytes = (raw: unknown): Uint8Array => {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (typeof raw === "string" && raw.startsWith("\\x")) {
    // Postgres hex-format bytea, returned literally. Two hex chars
    // per byte after the "\x" prefix.
    const hex = raw.slice(2);
    if (hex.length % 2 !== 0) {
      throw new Error(`plastron-postgres: malformed hex bytea (odd length).`);
    }
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  throw new Error(
    `plastron-postgres: expected bytea column to decode as Uint8Array/Buffer; ` +
    `got ${typeof raw}.`,
  );
};

const toIso = (v: Date | string): string => {
  if (v instanceof Date) return v.toISOString();
  // pg without a Date type-parser returns the raw timestamptz string.
  // Re-parse so the caller always sees ISO-8601.
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    // Last resort — surface what we got rather than NaN.
    return String(v);
  }
  return d.toISOString();
};
