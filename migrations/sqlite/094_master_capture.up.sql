-- Master data learns to say what changed, so it can replicate whole, by revision (docs/37 W.1, 013).
--
-- WHY THE DATABASE MARKS IT, NOT EACH SCREEN. About fifty write paths touch master data. If each had
-- to remember to queue its record, the first one that forgot would silently never replicate -- the
-- same failure as the 26 screens found on 2026-10-25 that dropped refused writes because each had
-- to remember to show them. So triggers on the master tables mark the changed RECORD, in the same
-- transaction as the write, and one builder later snapshots each marked record whole and queues it.
--
-- THE TRIGGERS ARE NOT IN THIS FILE. The migration runner splits a file on semicolons and a trigger
-- body needs them. They are generated from one map (packages/data/src/database/masterCapture.ts),
-- dropped at the start of every migration run -- so no migration can fire them or trip over them
-- while rebuilding a table -- and installed again after it, on every start. A rebuild migration that
-- drops a table's triggers is therefore repaired on the next start, not silently left uncaptured.
--
-- THIS FILE HOLDS THE TABLES THEY WRITE.
--
--   sync_capture          one row. suppressed = 1 turns marking off for writes that must not count
--                         as this computer's own changes: applying another computer's revision, and
--                         the backfill. It is set and reset inside the same transaction as those
--                         writes, so a crash rolls it back with them and it can never be left on.
--
--   sync_dirty_records    the records changed since they were last queued, one row per RECORD, not
--                         per row written. A material and its values and unit steps are one record,
--                         so an import of 400 materials is 400 marks, and 50 edits to one material
--                         before the next pass are still one. lease_epoch is the master-data lease
--                         this computer held at the moment of the write, as a leased event is
--                         stamped -- a change made under a lease since lost is refused visibly when
--                         pushed, never sent under a later lease.
--
--   sync_record_revisions the last revision of each record this computer has queued or applied. A
--                         builder raises it by one per queued revision. Per-computer state, never
--                         replicated -- like the outbox it feeds.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS sync_capture (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK (suppressed IN (0, 1))
);

INSERT OR IGNORE INTO sync_capture (id, suppressed) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS sync_dirty_records (
  aggregate_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  lease_epoch INTEGER,
  marked_at TEXT NOT NULL,
  PRIMARY KEY (aggregate_type, record_id)
);

CREATE TABLE IF NOT EXISTS sync_record_revisions (
  aggregate_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (aggregate_type, record_id)
);
