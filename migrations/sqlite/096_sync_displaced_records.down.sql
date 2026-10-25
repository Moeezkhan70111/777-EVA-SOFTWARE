-- Forgets what was moved aside. The records keep their placeholder names until their own next
-- revision arrives, but are no longer shown as incomplete.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

DROP TABLE IF EXISTS sync_displaced_records;
