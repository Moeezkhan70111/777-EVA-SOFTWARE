// The small SQL surface the synchronisation machinery needs.
//
// Declared here rather than importing @erp/data on purpose. The sync package must not depend on
// the database implementation — it is handed a connection and works through it — and a dependency
// in that direction would also make the build order and the lockfile say something that is not
// true. The shape matches node:sqlite's DatabaseSync structurally, so callers pass the handle they
// already have.

/** Everything SQLite will bind as a parameter. */
export type SqlValue = null | number | bigint | string | Uint8Array;

export interface SyncStatement {
  all(...params: SqlValue[]): unknown[];
  get(...params: SqlValue[]): unknown;
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

export interface SyncSqlHandle {
  prepare(sql: string): SyncStatement;
  exec(sql: string): void;
}

/** How many rows a write touched, as a plain number. node:sqlite may answer with a bigint. */
export const changedRows = (result: { changes: number | bigint }): number => Number(result.changes);

/** A row as SQLite hands it back, before anything is read out of it. */
export const asRow = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
