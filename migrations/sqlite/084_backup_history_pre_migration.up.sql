-- A backup taken automatically BEFORE a migration run needs a type of its own.
--
-- backup_history.backup_type allowed exactly 'AUTO_DAILY' and 'MANUAL'. The safety copy the
-- application now takes before it migrates is neither: nobody asked for it, and it is not a
-- daily rhythm. It happens because the schema is about to change, and that is the one fact an
-- operator needs when they are looking for a way back after an upgrade went wrong.
--
-- Recording it as 'MANUAL' would have avoided this migration and been a lie in the one table
-- somebody reads under pressure, so the constraint gains a third value instead.
--
-- WHY A TABLE REBUILD. SQLite cannot alter a CHECK constraint -- there is no DROP CONSTRAINT and
-- no MODIFY COLUMN -- so widening one means building the table again and copying the rows over.
-- That is safe here in a way it would not be for a business table: backup_history is bookkeeping
-- about files on disk, it has no foreign keys in either direction, nothing references it, and it
-- carries no index. The copy below is column-for-column with no transformation.
--
-- The migration runner wraps every pending file in one transaction with foreign keys disabled,
-- so the DROP and RENAME below cannot leave a half-rebuilt table behind.
--
-- Nothing is renumbered, no row is dropped, and no existing backup file is touched. A database
-- that has never taken a backup simply copies zero rows.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS backup_history_new (
  id TEXT PRIMARY KEY,
  backup_type TEXT NOT NULL,
  backup_path TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  verification_at TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (backup_type IN ('AUTO_DAILY','MANUAL','PRE_MIGRATION')),
  CHECK (status IN ('CREATED','VERIFIED','FAILED','RESTORED'))
);

INSERT INTO backup_history_new (
  id, backup_type, backup_path, checksum_sha256, size_bytes,
  verified, verification_at, status, created_at
)
SELECT
  id, backup_type, backup_path, checksum_sha256, size_bytes,
  verified, verification_at, status, created_at
FROM backup_history;

DROP TABLE backup_history;

ALTER TABLE backup_history_new RENAME TO backup_history;
