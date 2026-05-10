// ========================================================================
// Minimal structural types for the bits of the `pg` API this adapter
// touches. We declare them locally so the package can type-check
// without `@types/pg` installed — `pg` is a peerDependency, the host
// owns the real types and the connection pool.
//
// The real `pg` package's `Pool` and `Client` both expose a `.query`
// method with overloads. We only use the (text, values) → result form,
// so the structural type below is intentionally narrow. Anything
// passing as `pg.Pool` or `pg.Client` from a host will satisfy this.
// ========================================================================

export interface PgQueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number | null;
}

export interface PgQueryable {
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<PgQueryResult<R>>;
}
