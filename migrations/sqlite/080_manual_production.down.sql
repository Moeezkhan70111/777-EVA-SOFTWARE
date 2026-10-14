-- Takes the Manual Production record back out. The stock it added stays where it is -- this only
-- removes the history of where that stock came from, so run it only on a database with no entries.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

DROP INDEX IF EXISTS idx_manual_production_entries_program;

DROP INDEX IF EXISTS idx_manual_production_entries_ts;

DROP TABLE IF EXISTS manual_production_entries;
