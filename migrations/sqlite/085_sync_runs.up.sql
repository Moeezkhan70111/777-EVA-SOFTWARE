-- WHEN THIS COMPUTER LAST TRIED TO SYNC, AND WHETHER IT WORKED.
--
-- The Cloud Sync panel could not answer either question. It showed when a row was last SENT,
-- read off sync_outbox -- so a pass that pushed nothing left no trace at all, and a pass that
-- failed left none either. "Last sync: never" on a computer that had been syncing all day,
-- because nothing happened to need sending, is not a useful thing to show somebody.
--
-- Worse, it made a background sync untellable from a broken one. Once passes run on a timer
-- rather than a button, "is this working?" is the only question that matters, and answering it
-- needs the attempts recorded, not their side effects inferred.
--
-- ONE ROW PER PASS. Six or so a day per computer, so a few thousand rows a year -- small enough
-- that nothing prunes it, and worth keeping: the history is what shows a computer that has been
-- failing since Tuesday rather than failing right now.
--
-- `trigger` says what started the pass, which is the difference between "the timer fired and it
-- worked" and "somebody pressed the button until it worked".
--
-- `outcome` is deliberately coarse. OK means the pass completed, whatever it carried. REFUSED
-- means the cloud would not accept this computer -- an enrolment problem, not a network one, and
-- the one case where nothing in the queue was touched. TRANSPORT_ERROR means it could not be
-- reached. FAILED is anything else, with `reason` carrying the service's own words.
--
-- Counts are nullable because a pass that never got past the claim has none to report. Zero and
-- "did not get that far" are different facts and this does not flatten them.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS sync_runs (
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
  CHECK (trigger IN ('STARTUP','TIMER','RECONNECT','MANUAL')),
  CHECK (outcome IS NULL OR outcome IN ('OK','REFUSED','TRANSPORT_ERROR','FAILED'))
);

-- The panel asks two questions of this table -- the latest attempt, and the latest success --
-- and both read newest-first.
CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_runs_outcome_started ON sync_runs(outcome, started_at DESC);
