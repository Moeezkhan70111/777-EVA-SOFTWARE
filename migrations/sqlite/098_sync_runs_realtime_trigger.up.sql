-- sync_runs learns a sixth trigger: REALTIME, a pass started because the cloud's doorbell rang.
--
-- WHY. A reading computer used to learn of another computer's work on its next timer pass, up to a
-- minute later. It now also subscribes to the cloud log's doorbell (cloud migration 016) and starts a
-- pass within moments of a ring. Recorded as its own trigger, like SAVE (092), because sync_runs
-- exists to tell what started each pass -- and "the doorbell worked" is a fact worth seeing.
--
-- WHY A TABLE REBUILD. SQLite cannot alter a CHECK constraint. sync_runs is this computer's own
-- record of its passes (per-computer state, never replicated), and every row is copied across.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE sync_runs_with_realtime (
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
  CHECK (trigger IN ('STARTUP','TIMER','RECONNECT','MANUAL','SAVE','REALTIME')),
  CHECK (outcome IS NULL OR outcome IN ('OK','REFUSED','TRANSPORT_ERROR','FAILED'))
);

INSERT INTO sync_runs_with_realtime (id, started_at, finished_at, trigger, outcome, pushed, fetched, applied, duplicates, refused, reason)
SELECT id, started_at, finished_at, trigger, outcome, pushed, fetched, applied, duplicates, refused, reason
FROM sync_runs
ORDER BY rowid;

DROP TABLE sync_runs;
ALTER TABLE sync_runs_with_realtime RENAME TO sync_runs;
CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_outcome_started ON sync_runs(outcome, started_at DESC);
