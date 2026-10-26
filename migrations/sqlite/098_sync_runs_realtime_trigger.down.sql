-- Narrows sync_runs.trigger back, removing REALTIME.
--
-- WRITTEN TO FAIL when it would lose information: a recorded REALTIME pass violates the narrowed
-- CHECK and the whole migration rolls back. Filtering those rows out would silently erase passes
-- from this computer's record of what it did.
--
-- Nothing executes this file: the runner reads *.up.sql only. It exists so the forward migration
-- can be read against its inverse.
--
-- (No semicolons in comments.)

CREATE TABLE sync_runs_without_realtime (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  trigger TEXT NOT NULL,
  outcome TEXT,
  pushed INTEGER,
  fetched INTEGER,
  applied INTEGER,
  duplicates INTEGER,
  refused INTEGER,
  reason TEXT,
  CHECK (trigger IN ('STARTUP','TIMER','RECONNECT','MANUAL','SAVE')),
  CHECK (outcome IS NULL OR outcome IN ('OK','REFUSED','TRANSPORT_ERROR','FAILED'))
);

INSERT INTO sync_runs_without_realtime (id, started_at, finished_at, trigger, outcome, pushed, fetched, applied, duplicates, refused, reason)
SELECT id, started_at, finished_at, trigger, outcome, pushed, fetched, applied, duplicates, refused, reason
FROM sync_runs
ORDER BY rowid;

DROP TABLE sync_runs;
ALTER TABLE sync_runs_without_realtime RENAME TO sync_runs;
CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_outcome_started ON sync_runs(outcome, started_at DESC);
