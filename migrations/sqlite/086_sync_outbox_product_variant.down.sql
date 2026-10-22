-- Narrows sync_outbox.aggregate_type back, removing PRODUCT_VARIANT.
--
-- WRITTEN TO FAIL when it would lose information. A PRODUCT_VARIANT row still in the queue
-- violates the narrowed CHECK and the whole migration rolls back. Filtering those rows out
-- instead would discard a variant the cloud has not been given, and the carton that needs it
-- would then be refused with UNKNOWN_PRODUCT_VARIANT and no record of why.
--
-- To reverse this deliberately, let the queue drain first so no PRODUCT_VARIANT row remains.
--
-- Nothing executes this file: electron-builder ships only *.up.sql and the runner reads only
-- those. It exists so the forward migration's shape is reviewable against its reverse.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE sync_outbox_without_variant (
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
  transient_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (aggregate_type IN ('QR_MASTER','PRODUCTION_EVENT','PRODUCTION_PRODUCED','DISPATCH_EVENT','RETURN_EVENT','PROJECTION')),
  CHECK (operation IN ('INSERT','UPDATE')),
  CHECK (status IN ('PENDING','IN_FLIGHT','FAILED','DEAD_LETTER','SYNCED'))
);

INSERT INTO sync_outbox_without_variant (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;

ALTER TABLE sync_outbox_without_variant RENAME TO sync_outbox;

CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
