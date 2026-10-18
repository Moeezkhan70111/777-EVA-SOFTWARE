-- Puts the original aggregate-type list back.
--
-- Deliberately NOT destructive: if any PRODUCTION_PRODUCED rows are still queued, the copy below
-- fails the CHECK and the whole migration rolls back. That is the safe outcome. Those rows are
-- business events waiting to be sent, and a down migration must not delete them silently --
-- drain or review them first, then run this.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE sync_outbox_reverted (
  id TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  lock_token TEXT,
  available_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (aggregate_type IN ('QR_MASTER','PRODUCTION_EVENT','DISPATCH_EVENT','RETURN_EVENT','PROJECTION')),
  CHECK (operation IN ('INSERT','UPDATE')),
  CHECK (status IN ('PENDING','IN_FLIGHT','FAILED','DEAD_LETTER','SYNCED'))
);

INSERT INTO sync_outbox_reverted (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, last_error, created_at, updated_at
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, last_error, created_at, updated_at
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;

ALTER TABLE sync_outbox_reverted RENAME TO sync_outbox;

CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
