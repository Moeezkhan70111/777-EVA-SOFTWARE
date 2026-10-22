-- Narrows backup_history.backup_type back to 'AUTO_DAILY' and 'MANUAL'.
--
-- THIS IS WRITTEN TO FAIL when it would lose information, and that is deliberate.
--
-- If any PRE_MIGRATION row exists, the INSERT below violates the narrowed CHECK constraint on
-- the rebuilt table and the whole migration rolls back. The alternative -- filtering those rows
-- out, or rewriting them as 'MANUAL' -- would quietly discard or misattribute the record of
-- which backup was taken before which upgrade. That record is the thing somebody needs when an
-- upgrade has gone wrong, so it is not something a rollback may silently edit.
--
-- To reverse this deliberately, delete the PRE_MIGRATION rows yourself first, having decided
-- what happens to the backup files they point at. The files themselves are never touched by any
-- migration, up or down.
--
-- Nothing executes this file: electron-builder ships only *.up.sql and the runner reads only
-- those. It exists so the forward migration's shape is reviewable against its reverse.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS backup_history_old (
  id TEXT PRIMARY KEY,
  backup_type TEXT NOT NULL,
  backup_path TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  verification_at TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (backup_type IN ('AUTO_DAILY','MANUAL')),
  CHECK (status IN ('CREATED','VERIFIED','FAILED','RESTORED'))
);

INSERT INTO backup_history_old (
  id, backup_type, backup_path, checksum_sha256, size_bytes,
  verified, verification_at, status, created_at
)
SELECT
  id, backup_type, backup_path, checksum_sha256, size_bytes,
  verified, verification_at, status, created_at
FROM backup_history;

DROP TABLE backup_history;

ALTER TABLE backup_history_old RENAME TO backup_history;
