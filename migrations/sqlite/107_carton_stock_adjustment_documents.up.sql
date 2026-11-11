-- Stock Adjustment documents (docs/46): Opening Stock and Stock Adjustment, posted on the carton computer.
--
-- A DOCUMENT OVER THE MOVEMENTS THAT ALREADY EXIST. Each line moves the figure by one CARTON_ADJUST_IN or
-- CARTON_ADJUST_OUT movement on carton_stock_events (local 103, cloud 027), which travels and applies exactly as
-- before. The document says what the lines were for: its number, its kind (OPENING or ADJUSTMENT), its date, its
-- reason and who posted it. It travels as a leased record of its own, CARTON_STOCK_ADJUSTMENT, under the carton
-- lease (cloud 030). A posted document is never changed: a mistake is corrected by another document.
--
-- A line names its movement (carton_stock_event_id) rather than the movement naming the document: the movement
-- table and its cloud twin stay as they are, and a computer that receives the movement before the document still
-- applies the movement.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS carton_stock_adjustments (
  id TEXT PRIMARY KEY,
  document_number INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('OPENING', 'ADJUSTMENT')),
  business_date TEXT NOT NULL CHECK (length(business_date) = 10),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  remarks TEXT,
  posted_by TEXT NOT NULL CHECK (length(trim(posted_by)) > 0),
  workstation_code TEXT,
  stock_location_id TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  origin_device_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_carton_stock_adjustments_number ON carton_stock_adjustments(document_number);

CREATE TABLE IF NOT EXISTS carton_stock_adjustment_lines (
  id TEXT PRIMARY KEY,
  adjustment_id TEXT NOT NULL REFERENCES carton_stock_adjustments(id),
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  product_variant_id TEXT NOT NULL REFERENCES product_variants(id),
  article_size_id TEXT NOT NULL,
  article TEXT NOT NULL,
  size TEXT NOT NULL,
  color TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('IN', 'OUT')),
  cartons INTEGER NOT NULL CHECK (cartons > 0),
  carton_stock_event_id TEXT NOT NULL UNIQUE,
  UNIQUE (adjustment_id, line_no),
  UNIQUE (adjustment_id, product_variant_id)
);

CREATE INDEX IF NOT EXISTS idx_carton_stock_adjustment_lines_variant ON carton_stock_adjustment_lines(product_variant_id);

-- THE OUTBOX LEARNS THE NEW RECORD TYPE, by the same rebuild as 095, 101, 104 and 106.

CREATE TABLE sync_outbox_with_adjustments (
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
    'STOCK_EVENT','CARTON_STOCK_EVENT',
    'MAIN_GROUP','PRODUCT_GROUP','ARTICLE_SERIES','PRODUCT_TYPE','PRODUCT_SUB_GROUP','ARTICLE_SIZE',
    'MANUAL_PRODUCTION_ENTRY','GATEPASS','SALE_VOUCHER','CASH_VOUCHER',
    'COLOR_TRANSLATION',
    'CARTON_STOCK_ADJUSTMENT'
  )),
  CHECK (operation IN ('INSERT','UPDATE')),
  CHECK (status IN ('PENDING','IN_FLIGHT','FAILED','DEAD_LETTER','SYNCED'))
);

INSERT INTO sync_outbox_with_adjustments (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;
ALTER TABLE sync_outbox_with_adjustments RENAME TO sync_outbox;
CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
