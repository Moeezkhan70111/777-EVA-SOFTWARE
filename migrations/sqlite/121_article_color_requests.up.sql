-- A NEW COLOUR ASKED FOR FROM ENTER ORDERS (owner, 27 Nov 2026: "MAKE BOSS PC CAN ALSO ADD NEW COLOR IN ENTER ORDERS",
-- and "AUTO ACCEPT IT FROM PC1").
--
-- Colours are Product Master, written only by the computer holding MASTER_DATA (PC1). The boss enters orders on PC3,
-- which holds ORDERS. So on PC3 "+ New colour" writes a REQUEST: the article and the colour, as text, and who asked.
-- It travels as the ARTICLE_COLOR_REQUEST leased record under ORDERS (cloud 043). PC1 adds the colour on arrival by
-- itself, through the same addColorToArticle as its own "+ New colour", in the same sync pass, and the article's sizes
-- travel back to every computer as they always do. Nobody accepts anything.
--
--   article_color_requests          the orders computer's record. Written once, never changed.
--   article_color_request_results   the Product Master computer's own note of each request it has dealt with, and
--                                   how: sizes added, or why it was refused. It never travels.
--
-- No stock, money, ledger or order figure reads these tables.
--
-- THE OUTBOX LEARNS ONE TYPE, by the same rebuild as 116 and 117. Every type they allowed stays allowed. Until cloud
-- 043 is applied a request waits as UNKNOWN_RECORD_TYPE and nothing else is held up.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS article_color_requests (
  id TEXT PRIMARY KEY,
  article TEXT NOT NULL,
  color TEXT NOT NULL,
  requested_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  origin_device_id TEXT,
  CHECK (TRIM(article) <> ''),
  CHECK (TRIM(color) <> '')
);

CREATE TABLE IF NOT EXISTS article_color_request_results (
  request_id TEXT PRIMARY KEY,
  dealt_at TEXT NOT NULL,
  sizes_added INTEGER NOT NULL DEFAULT 0,
  refusal TEXT
);

CREATE TABLE sync_outbox_with_color_requests (
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
    'PRODUCTION_DAY',
    'STORE_HAND_VOUCHER',
    'LEDGER_ARCHIVE_STATEMENT','LEDGER_ARCHIVE_ENTRY_PAGE',
    'CUSTOMER_ORDER','GATEPASS_ORDER_ALLOCATION',
    'PARTY_OPENING_BALANCE',
    'PURCHASE_VOUCHER',
    'PARTY_CLAIM_REQUEST','PARTY_CLAIM','PARTY_CLAIM_REJECTION',
    'SALE_RETURN',
    'ARTICLE_COLOR_REQUEST'
  )),
  CHECK (operation IN ('INSERT','UPDATE')),
  CHECK (status IN ('PENDING','IN_FLIGHT','FAILED','DEAD_LETTER','SYNCED'))
);

INSERT INTO sync_outbox_with_color_requests (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;
ALTER TABLE sync_outbox_with_color_requests RENAME TO sync_outbox;
CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
