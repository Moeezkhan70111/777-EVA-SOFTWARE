-- The outbox learns to carry master-data records and stock events.
--
-- WHY. Master data now replicates whole, by revision (cloud migration 013): eight record types,
-- built from the marks the capture triggers leave (migration 094, masterRecords.ts). Stock events
-- are the next type in the stock-screen slice (docs/37). Each needs its type allowed here.
--
-- WITHOUT THIS MIGRATION NOTHING FAILS VISIBLY at the write. enqueueSyncEvent never throws, so a
-- narrower CHECK would refuse the queue row and the save would carry on. The builder therefore
-- checks the answer and leaves the mark in place when a row is refused -- but the record would
-- never travel. This widening is what makes the queueing real.
--
-- WHY A TABLE REBUILD. SQLite cannot alter a CHECK constraint. The same rebuild as 086 and 090:
-- sync_outbox is this computer's own queue, every row is reconstructible, and nothing references it.
--
-- EVERY COLUMN AND INDEX IS CARRIED OVER, transient_attempts (083) and lease_epoch (093) included,
-- and status and attempt counts are preserved exactly, so a parked row stays parked.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE sync_outbox_with_leased_records (
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
  lease_epoch INTEGER,
  CHECK (aggregate_type IN (
    'QR_MASTER','PRODUCT_VARIANT','PRODUCTION_EVENT','PRODUCTION_PRODUCED','DISPATCH_EVENT','RETURN_EVENT','PROJECTION',
    'RAW_MATERIAL_QR_BATCH','RAW_MATERIAL_QR',
    'PARTY_GROUP','PARTY','INVENTORY_UNIT','UNIT_LADDER_PRESET','INVENTORY_CATEGORY','INVENTORY_ITEM','WORK_SECTION','MACHINE',
    'STOCK_EVENT'
  )),
  CHECK (operation IN ('INSERT','UPDATE')),
  CHECK (status IN ('PENDING','IN_FLIGHT','FAILED','DEAD_LETTER','SYNCED'))
);

INSERT INTO sync_outbox_with_leased_records (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;
ALTER TABLE sync_outbox_with_leased_records RENAME TO sync_outbox;
CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
