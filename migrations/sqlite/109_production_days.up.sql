-- Today's production, marked complete (docs/48): the "Complete today's production" button on the Manual Production page.
--
-- ONE ROW PER BUSINESS DAY, written once when the operator says the day's production is all entered. It moves no
-- stock: every carton is already in the figure through its own Manual Production entry and MANUAL_PRODUCE movement
-- (080, 103). It only says "the figures for this day are in", which Carton Stock shows as Production added, on every
-- computer, and Daily Production shows beside the day.
--
-- id             production-day:YYYY-MM-DD, so the same day is the same record on every computer.
-- business_date  the Asia/Karachi day (businessDateOf in @erp/domain). UNIQUE: a day is completed once.
-- cartons        the day's live Manual Production cartons when it was marked, for the record. Later entries or
--                voids are not written back here: the day's figure is always read from the entries.
-- entries        how many live entries the day had when it was marked.
--
-- Replicated as the PRODUCTION_DAY leased record under CARTON_STOCK, written where production is recorded. The
-- cloud learns the type from cloud migration 032, prepared and not applied: until it is, a completed day waits as
-- UNKNOWN_RECORD_TYPE and nothing else is held up.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS production_days (
  id TEXT PRIMARY KEY,
  business_date TEXT NOT NULL UNIQUE CHECK (length(business_date) = 10),
  completed_at TEXT NOT NULL,
  completed_by TEXT NOT NULL CHECK (length(trim(completed_by)) > 0),
  cartons INTEGER NOT NULL CHECK (cartons >= 0),
  entries INTEGER NOT NULL CHECK (entries >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- THE OUTBOX LEARNS THE NEW RECORD TYPE, by the same rebuild as 095, 101, 104, 106 and 107.

CREATE TABLE sync_outbox_with_production_days (
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
    'CARTON_STOCK_ADJUSTMENT',
    'PRODUCTION_DAY'
  )),
  CHECK (operation IN ('INSERT','UPDATE')),
  CHECK (status IN ('PENDING','IN_FLIGHT','FAILED','DEAD_LETTER','SYNCED'))
);

INSERT INTO sync_outbox_with_production_days (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;
ALTER TABLE sync_outbox_with_production_days RENAME TO sync_outbox;
CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
