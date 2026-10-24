-- The outbox learns to carry raw-material label runs and packet identities.
--
-- WHY. Raw material is the first domain to replicate end to end (docs/37, owner decision
-- 2026-10-23). A packet's movements cannot be applied on another computer until that computer
-- holds the packet, and a packet cannot be held until its label run is there. So the run and its
-- packets are the first raw-material facts to travel: RAW_MATERIAL_QR_BATCH and RAW_MATERIAL_QR.
-- The receiving half is packages/sync/src/rawMaterialContracts.ts.
--
-- WITHOUT THIS MIGRATION NOTHING FAILS VISIBLY. enqueueSyncEvent never throws, on purpose: losing
-- the chance to tell another computer about a label run must never cost the label run. So a
-- narrower CHECK would refuse the queue row, the generator would carry on, and the run would
-- simply never be sent. This widening is what makes the queueing real.
--
-- WHY A TABLE REBUILD. SQLite cannot alter a CHECK constraint. The same rebuild as migration 086,
-- for the same reasons: sync_outbox is this computer's own queue, every row is reconstructible
-- from the tables it refers to, and nothing references it.
--
-- EVERY COLUMN AND INDEX IS CARRIED OVER, transient_attempts included (migration 083), and status
-- and attempt counts are preserved exactly, so a parked row stays parked.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE sync_outbox_with_raw_material (
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
  CHECK (aggregate_type IN ('QR_MASTER','PRODUCT_VARIANT','PRODUCTION_EVENT','PRODUCTION_PRODUCED','DISPATCH_EVENT','RETURN_EVENT','PROJECTION','RAW_MATERIAL_QR_BATCH','RAW_MATERIAL_QR')),
  CHECK (operation IN ('INSERT','UPDATE')),
  CHECK (status IN ('PENDING','IN_FLIGHT','FAILED','DEAD_LETTER','SYNCED'))
);

INSERT INTO sync_outbox_with_raw_material (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;
ALTER TABLE sync_outbox_with_raw_material RENAME TO sync_outbox;
CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
