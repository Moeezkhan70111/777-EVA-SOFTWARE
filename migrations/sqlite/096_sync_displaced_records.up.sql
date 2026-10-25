-- What this computer moved aside to let another computer's master-data revision apply.
--
-- WHY. A revision of a master record can need a name that another record here still holds: two
-- parties swapping names arrive one revision at a time, each wanting the name the other has. Waiting
-- would wait for ever on both sides. But the store PC (the only writer) never holds two records of
-- one type under one name, so a clash with ANOTHER record of the same type means this computer's
-- copy of that other record is out of date. It is moved aside -- its clashing name becomes
-- "~moved:<its id>" -- the revision applies, and the moved record's own next revision puts its real
-- name back and clears its row here (packages/sync/src/leasedRecordContracts.ts).
--
-- Until then the move is not silent: each row here is shown as an incomplete record, with the
-- name it had, beside the waits (waiting.ts).
--
-- Per-computer state, never replicated.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS sync_displaced_records (
  aggregate_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  -- The columns moved aside and what they held, as JSON: {"party_name": "ALPHA"}.
  original_json TEXT NOT NULL,
  displaced_at TEXT NOT NULL,
  PRIMARY KEY (aggregate_type, record_id)
);
