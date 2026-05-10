// ========================================================================
// Minimal structural type for the SQLite handle. Both the Node backend
// (better-sqlite3) and the browser backend (@sqlite.org/sqlite-wasm)
// fit this shape via small wrappers in open.ts.
//
// Methods accept either sync or async returns: Node's better-sqlite3 is
// fully synchronous, so its wrapper returns raw values. The WASM backend
// is async (Promise-based) by nature. Adapter code awaits everything
// uniformly — `await syncValue` is a no-op, so this works transparently.
//
// We declare this locally so the package type-checks without either
// backend installed; both are peerDependencies. Hosts pull in whichever
// they need.
// ========================================================================

export type SqliteRow = Record<string, unknown>;

export interface SqliteHandle {
  /** Run a parameterized statement that returns no rows. INSERT, UPDATE,
   *  DELETE, CREATE, etc. */
  run(sql: string, params?: ReadonlyArray<unknown>): void | Promise<void>;

  /** Run and return the first row, or undefined when there are none. */
  get<T = SqliteRow>(
    sql: string, params?: ReadonlyArray<unknown>,
  ): T | undefined | Promise<T | undefined>;

  /** Run and return all rows. Empty array when there are none. */
  all<T = SqliteRow>(
    sql: string, params?: ReadonlyArray<unknown>,
  ): T[] | Promise<T[]>;

  /** Run multiple statements separated by semicolons. Used for
   *  migrations and ensureSchema, where binding parameters isn't
   *  applicable. The body runs without an enclosing transaction —
   *  callers wrap manually with `transaction` when atomicity matters. */
  exec(sql: string): void | Promise<void>;

  /** Run `fn` inside a transaction. Rollback on throw or rejected
   *  Promise; commit on clean return. Nested calls share the outer
   *  transaction (savepoint semantics handled per-backend, but the
   *  observable effect is "atomic block" either way). */
  transaction<R>(fn: (h: SqliteHandle) => R | Promise<R>): R | Promise<R>;

  /** Close + release native / WASM resources. Idempotent. */
  close(): void | Promise<void>;
}
