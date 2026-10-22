-- The outbox learns to carry a product variant.
--
-- WHY. A variant created locally and scanned minutes later is unknown to the cloud, so
-- push_qr_master refuses the carton with UNKNOWN_PRODUCT_VARIANT -- correctly, because a
-- receiving computer that invented a product rather than refusing the carton would be worse.
-- Observed on 2026-10-22 with SK46 BLACK 4/6, created at 17:26:22 and scanned at 17:26:32.
--
-- The cure was somebody inserting the variant by hand, and every new product, colour or size
-- repeated it. Now the variant travels ahead of the carton that needs it.
--
-- INSERT-ONLY, AND SO NO CONFLICT RULE. A variant's identity -- article, colour, size -- is
-- fixed at creation and nothing edits it. Only the description and prices change, and the cloud
-- is given neither. See migrations/supabase/008_push_product_variant.up.sql for the receiving
-- half and why prices are deliberately absent from the payload.
--
-- WHY A TABLE REBUILD. SQLite cannot alter a CHECK constraint, so widening aggregate_type means
-- building the table again and copying the rows. Safe here in a way it would not be for a
-- business table: sync_outbox is this computer's own queue of what it still has to send, every
-- row is reconstructible from the tables it refers to, and nothing references it.
--
-- EVERY COLUMN AND INDEX IS CARRIED OVER, including transient_attempts, which migration 083
-- added AFTER 082 last rebuilt this table -- so a rebuild copied from 082 alone would silently
-- drop it, and with it the separation between "the service refused this" and "this could not be
-- delivered". That separation is what stops an hour offline parking every queued carton.
--
-- Status and attempt counts are preserved exactly: a row part-way through its retries keeps its
-- place, and a parked row stays parked.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE sync_outbox_with_variant (
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
  CHECK (aggregate_type IN ('QR_MASTER','PRODUCT_VARIANT','PRODUCTION_EVENT','PRODUCTION_PRODUCED','DISPATCH_EVENT','RETURN_EVENT','PROJECTION')),
  CHECK (operation IN ('INSERT','UPDATE')),
  CHECK (status IN ('PENDING','IN_FLIGHT','FAILED','DEAD_LETTER','SYNCED'))
);

INSERT INTO sync_outbox_with_variant (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;

ALTER TABLE sync_outbox_with_variant RENAME TO sync_outbox;

CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
