-- Removes the parked-event inbox.
--
-- Anything parked is lost from this computer's view: its position is already behind the cursor, so
-- it would not be fetched again unless the cursor were also reset. Run only with the table empty,
-- or together with clearing sync.pull.cursor, so the log is read again from the beginning.
--
-- Nothing executes this file: the runner reads *.up.sql only. It exists so the forward migration
-- can be read against its inverse.
--
-- (No semicolons in comments.)

DROP INDEX IF EXISTS idx_sync_inbox_parked_next_try;
DROP TABLE IF EXISTS sync_inbox_parked;
