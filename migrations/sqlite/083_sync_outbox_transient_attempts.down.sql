-- Removes the separate count of undeliverable attempts.
--
-- SQLite can drop a column since 3.35, and node:sqlite is far newer, so this is a plain DROP.
-- What it loses is only bookkeeping: how long a row has been failing to reach the service. No
-- business data lives here, and the queue still works -- it simply goes back to spending one
-- budget on both kinds of failure, which is the behaviour this column exists to end.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE sync_outbox DROP COLUMN transient_attempts;
