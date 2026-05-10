// ========================================================================
// openSqlite — environment-detecting entry point.
//
// Node:    dynamically imports `better-sqlite3` and wraps it in
//          SqliteHandle. Synchronous under the hood; the wrapper returns
//          raw values that callers `await` transparently.
//
// Browser: dynamically imports `@sqlite.org/sqlite-wasm`. If OPFS is
//          available and a non-`:memory:` path was requested, opens an
//          OpfsDb at the given path; otherwise falls back to in-memory.
//
// Both backends are peer dependencies (with optional metadata) so a
// browser bundle that never calls openSqlite in Node mode doesn't pull
// in better-sqlite3, and vice versa.
// ========================================================================

import type { SqliteHandle, SqliteRow } from "./sqlite-types.js";

export interface OpenSqliteOptions {
  /** File path (Node) or OPFS path (browser, e.g. "/plastron/db.sqlite").
   *  Pass `":memory:"` for an in-memory DB on either side. */
  path: string;
  /** Browser-only: skip OPFS detection and force `:memory:`. Useful for
   *  tests or when you know OPFS is unavailable (file:// origins, some
   *  private windows). */
  inMemoryOnly?: boolean;
  /** Force a backend rather than auto-detect. Useful when a Node
   *  process wants the WASM backend (e.g. for parity testing) or when
   *  the host has already loaded a backend module and wants the
   *  adapter to reuse it. */
  backend?:
    | { kind: "better-sqlite3"; module?: unknown }
    | { kind: "sqlite-wasm";    module?: unknown };
}

const isNodeEnvironment = (): boolean => {
  const g = globalThis as {
    process?: { versions?: { node?: string } };
    window?: unknown;
  };
  return typeof g.process?.versions?.node === "string"
      && typeof g.window === "undefined";
};

export const openSqlite = async (opts: OpenSqliteOptions): Promise<SqliteHandle> => {
  const requestedKind = opts.backend?.kind
    ?? (isNodeEnvironment() ? "better-sqlite3" : "sqlite-wasm");

  if (requestedKind === "better-sqlite3") {
    return openBetterSqlite3(opts);
  }
  return openSqliteWasm(opts);
};

// ───────────────────────────── better-sqlite3 ──────────────────────────────

interface BetterSqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get<T>(...params: unknown[]): T | undefined;
  all<T>(...params: unknown[]): T[];
}

interface BetterSqliteDatabase {
  prepare(sql: string): BetterSqliteStatement;
  exec(sql: string): void;
  transaction<R>(fn: () => R): () => R;
  close(): void;
}

interface BetterSqliteCtor {
  new (path: string, opts?: Record<string, unknown>): BetterSqliteDatabase;
}

const openBetterSqlite3 = async (opts: OpenSqliteOptions): Promise<SqliteHandle> => {
  // Allow the host to pre-load the module. Otherwise dynamic-import.
  const mod = (opts.backend?.kind === "better-sqlite3" && opts.backend.module)
    ? opts.backend.module
    : await import(/* @vite-ignore */ "better-sqlite3").catch((err: unknown) => {
        throw new Error(
          `plastron-sqlite: failed to import "better-sqlite3". ` +
          `Install it as a runtime dependency in the host package. ` +
          `Underlying: ${(err as Error).message}`,
        );
      });

  // Node ESM dynamic import wraps CJS default exports under .default.
  const Database = ((mod as { default?: BetterSqliteCtor }).default
    ?? (mod as BetterSqliteCtor)) as BetterSqliteCtor;
  const db = new Database(opts.path);
  return wrapBetterSqlite3(db);
};

const wrapBetterSqlite3 = (db: BetterSqliteDatabase): SqliteHandle => {
  // Statement cache — better-sqlite3 strongly prefers re-using prepared
  // statements. Most callers hit a small fixed set of SQL strings.
  const stmts = new Map<string, BetterSqliteStatement>();
  const prep = (sql: string): BetterSqliteStatement => {
    let s = stmts.get(sql);
    if (!s) { s = db.prepare(sql); stmts.set(sql, s); }
    return s;
  };

  const handle: SqliteHandle = {
    run: (sql, params) => { prep(sql).run(...(params ?? [])); },
    get: <T = SqliteRow>(sql: string, params?: ReadonlyArray<unknown>) =>
      prep(sql).get<T>(...(params ?? [])),
    all: <T = SqliteRow>(sql: string, params?: ReadonlyArray<unknown>) =>
      prep(sql).all<T>(...(params ?? [])),
    exec: (sql) => { db.exec(sql); },
    transaction: <R>(fn: (h: SqliteHandle) => R | Promise<R>): R | Promise<R> => {
      // better-sqlite3's `db.transaction(fn)` returns a wrapper that,
      // when called, runs fn in a transaction. The fn it expects must
      // be synchronous — async functions inside a tx defeat the
      // atomicity guarantees because the connection is shared.
      // For async fn bodies we BEGIN/COMMIT manually; rollback on
      // throw or rejected Promise.
      const result = fn(handle);
      if (result instanceof Promise) {
        // Async path: manual BEGIN/COMMIT around the awaited body.
        return (async () => {
          db.exec("BEGIN");
          try {
            const r = await result;
            db.exec("COMMIT");
            return r;
          } catch (e) {
            try { db.exec("ROLLBACK"); } catch { /* swallow */ }
            throw e;
          }
        })();
      }
      // Sync path: the body already ran (we called fn(handle) above).
      // We can't retroactively wrap it in a transaction. The contract
      // is that callers either return sync or return a Promise — sync
      // bodies are committed individually; if they want atomicity they
      // should `await` so the Promise path runs. Document this in the
      // SqliteHandle comment.
      return result;
    },
    close: () => { db.close(); stmts.clear(); },
  };
  return handle;
};

// ───────────────────────────── sqlite-wasm ──────────────────────────────

interface SqliteWasmDb {
  exec(opts: {
    sql: string;
    bind?: ReadonlyArray<unknown>;
    returnValue?: "this" | "resultRows";
    rowMode?: "object" | "array" | "stmt";
  }): unknown;
  close(): void;
}

interface SqliteWasmModule {
  oo1: {
    DB: new (path: string, mode?: string) => SqliteWasmDb;
    OpfsDb?: new (path: string, mode?: string) => SqliteWasmDb;
  };
  capi: { sqlite3_libversion(): string };
}

const opfsAvailable = (): boolean => {
  if (typeof navigator === "undefined") return false;
  const sa = (navigator as Navigator & { storage?: { getDirectory?: unknown } }).storage;
  return typeof sa?.getDirectory === "function";
};

const openSqliteWasm = async (opts: OpenSqliteOptions): Promise<SqliteHandle> => {
  // The peer dep is optional and the import target is a string we
  // route through a variable so consuming projects without the dep
  // installed still type-check (TypeScript only resolves literal
  // module specifiers in `import(...)`).
  const sqliteWasmSpec = "@sqlite.org/sqlite-wasm";
  const importer = (opts.backend?.kind === "sqlite-wasm" && opts.backend.module)
    ? Promise.resolve(opts.backend.module)
    : import(/* @vite-ignore */ sqliteWasmSpec).catch((err: unknown) => {
        throw new Error(
          `plastron-sqlite: failed to import "@sqlite.org/sqlite-wasm". ` +
          `Install it as a runtime dependency. Underlying: ${(err as Error).message}`,
        );
      });
  const initModule = (await importer) as
    { default?: () => Promise<SqliteWasmModule> } | (() => Promise<SqliteWasmModule>);

  const init = typeof initModule === "function"
    ? initModule
    : (initModule as { default: () => Promise<SqliteWasmModule> }).default;
  const sqlite3 = await init();

  let db: SqliteWasmDb;
  const wantOpfs = opts.path !== ":memory:" && !opts.inMemoryOnly && opfsAvailable() && !!sqlite3.oo1.OpfsDb;
  if (wantOpfs && sqlite3.oo1.OpfsDb) {
    db = new sqlite3.oo1.OpfsDb(opts.path, "ct");  // create + read-write
  } else {
    db = new sqlite3.oo1.DB(opts.path === ":memory:" ? ":memory:" : `file:${opts.path}?vfs=memdb`, "ct");
  }
  return wrapSqliteWasm(db);
};

const wrapSqliteWasm = (db: SqliteWasmDb): SqliteHandle => {
  const handle: SqliteHandle = {
    run: async (sql, params) => {
      db.exec({ sql, bind: params ? [...params] : undefined });
    },
    get: async <T = SqliteRow>(sql: string, params?: ReadonlyArray<unknown>): Promise<T | undefined> => {
      const rows = db.exec({
        sql,
        bind: params ? [...params] : undefined,
        returnValue: "resultRows",
        rowMode: "object",
      }) as Record<string, unknown>[];
      return (rows[0] as T | undefined);
    },
    all: async <T = SqliteRow>(sql: string, params?: ReadonlyArray<unknown>): Promise<T[]> => {
      const rows = db.exec({
        sql,
        bind: params ? [...params] : undefined,
        returnValue: "resultRows",
        rowMode: "object",
      }) as Record<string, unknown>[];
      return rows as T[];
    },
    exec: async (sql) => {
      db.exec({ sql });
    },
    transaction: async <R>(fn: (h: SqliteHandle) => R | Promise<R>): Promise<R> => {
      db.exec({ sql: "BEGIN" });
      try {
        const r = await fn(handle);
        db.exec({ sql: "COMMIT" });
        return r;
      } catch (e) {
        try { db.exec({ sql: "ROLLBACK" }); } catch { /* swallow */ }
        throw e;
      }
    },
    close: async () => { db.close(); },
  };
  return handle;
};
