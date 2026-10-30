-- sync_runs learns a fifth trigger: SAVE, a pass started because something was just queued.
--
-- WHY. Until now new work reached the cloud on the next timer pass, up to five minutes later. A
-- pass now also starts shortly after a save queues something (push on save). The save itself never
-- waits for it: the queue row is written in the save's own transaction, and the pass runs in the
-- background afterwards, so a save cannot be slowed or failed by the network.
--
-- Recorded as its own trigger, not as TIMER, because sync_runs exists to tell "the timer worked"
-- from "something else started it" -- and a pass that ran because of a save is a different fact.
--
-- WHY A TABLE REBUILD. SQLite cannot alter a CHECK constraint. sync_runs is this computer's own
-- record of its passes (per-computer state, never replicated), and every row is copied across.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE sync_runs_with_save (
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

INSERT INTO sync_runs_with_save (id, started_at, finished_at, trigger, outcome, pushed, fetched, applied, duplicates, refused, reason)
SELECT id, started_at, finished_at, trigger, outcome, pushed, fetched, applied, duplicates, refused, reason
FROM sync_runs
ORDER BY rowid;

DROP TABLE sync_runs;
ALTER TABLE sync_runs_with_save RENAME TO sync_runs;
CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_outcome_started ON sync_runs(outcome, started_at DESC);
