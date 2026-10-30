-- Forgets which master records changed, and their revisions. The capture triggers are dropped by
-- code (masterCapture.ts) whenever the tables they write are missing, so nothing else is needed here.
--
-- What it costs: changes made since the last pass are no longer known to be unsent, and revision
-- counters restart -- a later revision then collides with the cloud's (REVISION_CONFLICT, visible).
--
-- (No semicolons in comments: the migration runner splits statements on them.)

DROP TABLE IF EXISTS sync_record_revisions;
DROP TABLE IF EXISTS sync_dirty_records;
DROP TABLE IF EXISTS sync_capture;
