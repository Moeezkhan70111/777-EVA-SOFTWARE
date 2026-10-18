-- PRODUCED stops being an event you identify by what is missing from it.
--
--   Five different business events share the aggregate type PRODUCTION_EVENT today, with four
--   different payload shapes, and the only way to tell a production scan from the other four is
--   that its payload has no eventType field. An event recognised by an absence cannot be applied
--   on another computer without guessing.
--
-- This adds ONE aggregate type, PRODUCTION_PRODUCED, so a production scan says what it is. The
-- other four keep travelling as PRODUCTION_EVENT until each is given its own contract, and the
-- receiving side refuses them explicitly rather than guessing at their shape.
--
-- PRODUCTION_EVENT stays in the list on purpose: rows already queued under it must remain valid.
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt. Rows are copied in rowid order
-- so their queue order survives, and the one index is recreated after the rename. The migration
-- runner wraps this in a single transaction with foreign keys off, which is what a table rebuild
-- needs -- nothing references sync_outbox, so no other table is affected.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE sync_outbox_rebuilt (
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
  CHECK (aggregate_type IN ('QR_MASTER','PRODUCTION_EVENT','PRODUCTION_PRODUCED','DISPATCH_EVENT','RETURN_EVENT','PROJECTION')),
  CHECK (operation IN ('INSERT','UPDATE')),
  CHECK (status IN ('PENDING','IN_FLIGHT','FAILED','DEAD_LETTER','SYNCED'))
);

INSERT INTO sync_outbox_rebuilt (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, last_error, created_at, updated_at
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, last_error, created_at, updated_at
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;

ALTER TABLE sync_outbox_rebuilt RENAME TO sync_outbox;

CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
