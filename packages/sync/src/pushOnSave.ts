// PUSH ON SAVE, AT THE MOMENT OF THE SAVE.
//
// The main process also polls the queue once a second (newestSendableRow, newestStampedMark). That
// stays as the safety net. This is the event: temporary triggers on the app's own connection call
// back as a save queues something a pass would send -- a PENDING outbox row of a type the transport
// sends (stamped with its lease epoch, if its domain is leased), or a stamped master-data mark. The
// conditions are the watcher's own, so it never signals for something the watcher would ignore.
//
// THE CALLBACK RUNS INSIDE THE SAVE'S TRANSACTION. It must only note that something happened: it
// never touches the database, and it never throws, because a function that throws inside a trigger
// fails the save itself. The caller does its real work later (setImmediate), after the save. A save
// that is then rolled back has signalled for nothing, which costs one empty pass and nothing else.
//
// TEMPORARY, so nothing is written to the database file: the triggers belong to this connection and
// go with it. Writes made through another connection are not seen here; the watcher covers them.

import { LEASED_AGGREGATE_DOMAIN } from "@erp/data";

/** What installing needs from the connection: node:sqlite's DatabaseSync satisfies it. */
export interface PushOnSaveConnection {
  exec(sql: string): void;
  function(name: string, options: { deterministic?: boolean }, func: () => null): void;
}

const FUNCTION_NAME = "erp_push_on_save";
const AGGREGATE_TYPE = /^[A-Z][A-Z0-9_]*$/;
const CALL = `BEGIN SELECT ${FUNCTION_NAME}(); END`;

/** A fixed list of aggregate types as SQL literals. They come from code, never input, and are checked. */
function literals(types: readonly string[]): string {
  return types
    .map((type) => {
      if (!AGGREGATE_TYPE.test(type)) throw new Error(`Not an aggregate type: ${type}`);
      return `'${type}'`;
    })
    .join(", ");
}

/**
 * Calls `onQueued` whenever a save on `db` queues something a pass would send. Throws if the
 * triggers cannot be made (a schema without the queue tables); the caller falls back to the watcher.
 */
export function installPushOnSaveSignal(db: PushOnSaveConnection, pushableTypes: readonly string[], onQueued: () => void): void {
  db.function(FUNCTION_NAME, { deterministic: false }, () => {
    try {
      onQueued();
    } catch {
      // Never fail a save over a nudge: the watcher still sees the row.
    }
    return null;
  });
  if (pushableTypes.length > 0) {
    db.exec(
      `CREATE TEMP TRIGGER IF NOT EXISTS erp_push_on_save_outbox AFTER INSERT ON main.sync_outbox
         WHEN NEW.status = 'PENDING' AND NEW.aggregate_type IN (${literals(pushableTypes)})
           AND NOT (NEW.aggregate_type IN (${literals(Object.keys(LEASED_AGGREGATE_DOMAIN))}) AND NEW.lease_epoch IS NULL)
       ${CALL}`
    );
  }
  // A master-data edit leaves a mark (migration 094), written as an upsert: a first edit inserts it,
  // the next edit of the same record updates it.
  for (const event of ["INSERT", "UPDATE"] as const) {
    db.exec(
      `CREATE TEMP TRIGGER IF NOT EXISTS erp_push_on_save_mark_${event.toLowerCase()} AFTER ${event} ON main.sync_dirty_records
         WHEN NEW.lease_epoch IS NOT NULL
       ${CALL}`
    );
  }
}
