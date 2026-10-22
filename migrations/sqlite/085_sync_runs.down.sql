-- Removes the record of sync attempts.
--
-- Safe in the sense that matters: no business data lives here. A sync run is bookkeeping about
-- an attempt, and every carton, event and queue row it refers to lives in its own table and is
-- untouched by this.
--
-- What it loses is the ability to answer "has this computer been syncing?", which is the whole
-- reason the table exists. Reversing this puts the Cloud Sync panel back to inferring an answer
-- from sync_outbox side effects, which is what it did before and what was wrong with it.
--
-- Nothing executes this file: electron-builder ships only *.up.sql and the runner reads only
-- those. It exists so the forward migration's shape is reviewable against its reverse.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

DROP INDEX IF EXISTS idx_sync_runs_outcome_started;

DROP INDEX IF EXISTS idx_sync_runs_started;

DROP TABLE IF EXISTS sync_runs;
