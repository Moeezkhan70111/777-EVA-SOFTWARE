-- Undoes 101: the carton stock events and Manual Production's void.
--
-- WHAT IT COSTS. The movements go, and with them the record of why each carton figure is what it is.
-- The projections are NOT moved back -- they keep whatever the events put there, which is the true
-- figure. A voided entry loses its void and counts again in totals and the contractor ledger, so do
-- not reverse this on a computer that has voided anything.
--
-- Nothing executes this file: the runner reads *.up.sql only. It exists so the forward migration
-- can be read against its inverse.
--
-- (No semicolons in comments.)

DROP INDEX IF EXISTS idx_carton_stock_events_line_once;
DROP INDEX IF EXISTS idx_carton_stock_events_entry_once;
DROP INDEX IF EXISTS idx_carton_stock_events_gatepass;
DROP INDEX IF EXISTS idx_carton_stock_events_variant;
DROP TABLE IF EXISTS carton_stock_events;

ALTER TABLE manual_production_entries DROP COLUMN void_reason;
ALTER TABLE manual_production_entries DROP COLUMN voided_by;
ALTER TABLE manual_production_entries DROP COLUMN voided_at;

-- The outbox narrows back. WRITTEN TO FAIL while a carton movement is still queued: the narrowed
-- CHECK refuses its row and the whole migration rolls back, rather than dropping a movement unsent.

CREATE TABLE sync_outbox_without_carton_stock (
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

INSERT INTO sync_outbox_without_carton_stock SELECT * FROM sync_outbox ORDER BY rowid;
DROP TABLE sync_outbox;
ALTER TABLE sync_outbox_without_carton_stock RENAME TO sync_outbox;
CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
