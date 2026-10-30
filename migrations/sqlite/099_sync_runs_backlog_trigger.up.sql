-- sync_runs learns a seventh trigger: BACKLOG, a pass started at once because the one before it
-- stopped at its budget with more still to send or read.
--
-- WHY. A pass reads at most 5,000 log events (PULL_BUDGET) and sends at most 2,000 rows
-- (DRAIN_BUDGET). A new computer's first sync used to sit idle between full passes until the
-- minute timer -- 45 seconds of the 99 the rehearsal's empty reader took (2026-10-28). The next
-- pass now starts at once, and is recorded as its own trigger because sync_runs exists to tell
-- what started each pass.
--
-- WHY A TABLE REBUILD. As 098: SQLite cannot alter a CHECK constraint. Every row is copied across.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE sync_runs_with_backlog (
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
  CHECK (trigger IN ('STARTUP','TIMER','RECONNECT','MANUAL','SAVE','REALTIME','BACKLOG')),
  CHECK (outcome IS NULL OR outcome IN ('OK','REFUSED','TRANSPORT_ERROR','FAILED'))
);

INSERT INTO sync_runs_with_backlog (id, started_at, finished_at, trigger, outcome, pushed, fetched, applied, duplicates, refused, reason)
SELECT id, started_at, finished_at, trigger, outcome, pushed, fetched, applied, duplicates, refused, reason
FROM sync_runs
ORDER BY rowid;

DROP TABLE sync_runs;
ALTER TABLE sync_runs_with_backlog RENAME TO sync_runs;
CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_outcome_started ON sync_runs(outcome, started_at DESC);
