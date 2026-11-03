// What an operator is told when a write is refused, from the error the data layer threw.
//
// A refusal the data layer decided ("give a reason", "already voided", "disabled in Product Master")
// is already written for the operator and is passed on as it is. SQLite's own "database is locked"
// is not: it means another connection held the write lock (SQLITE_BUSY 5, SQLITE_LOCKED 6), the whole
// transaction was refused, and nothing was written. That is said in plain words the caller chooses,
// and pressing again is safe. Never retried automatically: the operator decides.

/** SQLite refused the write because another connection held the lock. Nothing was written. */
export const isDatabaseBusy = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const errcode = (error as Error & { errcode?: unknown }).errcode;
  return errcode === 5 || errcode === 6 || /database is locked|database table is locked/i.test(error.message);
};

/** The operator's words for a refused write: `busy` for a lock, the data layer's own words otherwise. */
export const refusalReason = (error: unknown, busy: string, otherwise: string): string => {
  if (isDatabaseBusy(error)) return busy;
  return error instanceof Error ? error.message : otherwise;
};
