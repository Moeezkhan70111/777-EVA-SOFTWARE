-- 101: carton stock, replicated (docs/42).
--
-- EVERY MOVEMENT OF THE CARTON FIGURE BECOMES A ROW. Manual Production stocks cartons, a gatepass
-- takes them out the moment it is made, cancelling it puts them back, and voiding a Manual Production
-- entry takes its cartons out again. Each is one append-only row here, written in the same
-- transaction as the projections it moves (stock_projection_by_variant and the WAREHOUSE row of
-- stock_projection_by_location). The rows replicate as CARTON_STOCK_EVENT (cloud 026), and a
-- receiving computer moves its projections by balance_delta, so every computer shows one figure.
--
-- quantity IS CARTONS, always positive. The type decides the sign and balance_delta records it,
-- checked here against the type (@erp/domain cartonStockDelta is the same rule).
--
-- location_type AND location_id NAME THE PROJECTION ROW MOVED, so a receiver moves the same row the
-- origin moved. Only WAREHOUSE (the store) is ever moved by these events.
--
-- THE SOURCE IDS ARE REFERENCES ONLY. A gatepass and a Manual Production entry do not replicate, so on
-- every other computer they dangle by design. No foreign key, and nothing ever waits for them. The
-- product variant DOES replicate and is a foreign key.
--
-- origin_device_id NULL MEANS MADE HERE, as for the numbered tables (087). The applier stamps the
-- sending device on every replicated row, and replicated_at says when it arrived.
--
-- A VOID HAPPENS ONCE, A CANCEL HAPPENS ONCE. The unique indexes below make a second void of one
-- entry, or a second cancel of one issued line, impossible in the database itself, under whatever
-- the application layer already refuses.
--
-- manual_production_entries GAINS ITS VOID. The entry is never deleted (a delete cannot replicate) -- it
-- is marked voided, with who, when and why, and the reason is required by the application.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS carton_stock_events (
  id TEXT PRIMARY KEY,
  product_variant_id TEXT NOT NULL REFERENCES product_variants(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('MANUAL_PRODUCE', 'GATEPASS_ISSUE', 'GATEPASS_CANCEL', 'MANUAL_PRODUCTION_VOID')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  balance_delta INTEGER NOT NULL,
  location_type TEXT NOT NULL CHECK (location_type = 'WAREHOUSE'),
  location_id TEXT NOT NULL CHECK (length(trim(location_id)) > 0),
  created_by TEXT,
  created_at TEXT NOT NULL,
  origin_device_id TEXT,
  replicated_at TEXT,
  manual_production_entry_id TEXT,
  gatepass_id TEXT,
  gatepass_line_id TEXT,
  CHECK (balance_delta = CASE WHEN event_type IN ('GATEPASS_ISSUE', 'MANUAL_PRODUCTION_VOID') THEN -quantity ELSE quantity END),
  CHECK (event_type NOT IN ('MANUAL_PRODUCE', 'MANUAL_PRODUCTION_VOID') OR manual_production_entry_id IS NOT NULL),
  CHECK (event_type NOT IN ('GATEPASS_ISSUE', 'GATEPASS_CANCEL') OR (gatepass_id IS NOT NULL AND gatepass_line_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_carton_stock_events_variant ON carton_stock_events(product_variant_id);
CREATE INDEX IF NOT EXISTS idx_carton_stock_events_gatepass ON carton_stock_events(gatepass_id) WHERE gatepass_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_carton_stock_events_entry_once
  ON carton_stock_events(manual_production_entry_id, event_type) WHERE manual_production_entry_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_carton_stock_events_line_once
  ON carton_stock_events(gatepass_line_id, location_id, event_type) WHERE gatepass_line_id IS NOT NULL;

ALTER TABLE manual_production_entries ADD COLUMN voided_at TEXT;
ALTER TABLE manual_production_entries ADD COLUMN voided_by TEXT;
ALTER TABLE manual_production_entries ADD COLUMN void_reason TEXT;

-- THE OUTBOX LEARNS TO CARRY CARTON_STOCK_EVENT, by the same rebuild as 095 (SQLite cannot alter a
-- CHECK). Without it nothing fails at the write -- enqueueSyncEvent never throws -- and the movement
-- would simply never travel. Every column, index, status and attempt count is carried over.

CREATE TABLE sync_outbox_with_carton_stock (
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
    'STOCK_EVENT','CARTON_STOCK_EVENT'
  )),
  CHECK (operation IN ('INSERT','UPDATE')),
  CHECK (status IN ('PENDING','IN_FLIGHT','FAILED','DEAD_LETTER','SYNCED'))
);

INSERT INTO sync_outbox_with_carton_stock (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;
ALTER TABLE sync_outbox_with_carton_stock RENAME TO sync_outbox;
CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
