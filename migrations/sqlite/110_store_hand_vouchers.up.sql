-- Store hand vouchers (docs/49): raw material moved in or out of the store without labels, as one numbered voucher.
--
--   direction IN    SIV-   materials that came in from a supplier, with an optional reference
--   direction OUT   SOV-   materials that went out to a supplier or contractor, saying what for (required)
--
-- A VOUCHER OVER THE MOVEMENTS THAT ALREADY EXIST. Each line is one movement on inventory_stock_events, made by the
-- same write as moving one material by hand (RECEIVE in, TRANSFER_OUT out), which travels and applies exactly as
-- before (STOCK_EVENT, cloud 015). The voucher says what the lines were for: its direction and number, its party,
-- its business day (Asia/Karachi), its note, and who wrote it, edited it or deleted it. Each direction is its own
-- series of numbers, so the number is unique per direction.
--
-- EDITED OR DELETED ON ITS OWN DAY ONLY, and never rewritten. An edit reverses every old line by a new movement
-- naming the voucher, and moves the new lines again, in one transaction: the lines here are replaced, the movements
-- are not. A delete reverses every line and marks the voucher DELETED. Its number and its lines stay.
--
-- A line names its movement (stock_event_id) rather than the movement naming the voucher: the movement table and
-- its cloud twin stay as they are, and a computer that receives the movement before the voucher still applies it.
--
-- Replicated as the STORE_HAND_VOUCHER leased record under RAW_MATERIAL_STORE, written where the store is. The cloud
-- learns the type from cloud migration 033: until it is applied, a voucher waits as UNKNOWN_RECORD_TYPE and nothing
-- else is held up.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS store_hand_vouchers (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('IN', 'OUT')),
  voucher_number INTEGER NOT NULL,
  business_date TEXT NOT NULL CHECK (length(business_date) = 10),
  party_id TEXT NOT NULL REFERENCES parties(id),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'DELETED')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  deleted_by TEXT,
  deleted_at TEXT,
  origin_device_id TEXT,
  CHECK (direction = 'IN' OR length(trim(COALESCE(note, ''))) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_store_hand_vouchers_number ON store_hand_vouchers(direction, voucher_number);
CREATE INDEX IF NOT EXISTS idx_store_hand_vouchers_date ON store_hand_vouchers(business_date);

CREATE TABLE IF NOT EXISTS store_hand_voucher_lines (
  id TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL REFERENCES store_hand_vouchers(id),
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  item_id TEXT NOT NULL REFERENCES inventory_items(id),
  item_name TEXT NOT NULL,
  typed_quantity REAL NOT NULL CHECK (typed_quantity > 0),
  typed_unit_code TEXT NOT NULL,
  quantity REAL NOT NULL CHECK (quantity > 0),
  stock_unit_code TEXT NOT NULL,
  stock_event_id TEXT NOT NULL UNIQUE,
  UNIQUE (voucher_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_store_hand_voucher_lines_item ON store_hand_voucher_lines(item_id);

-- THE OUTBOX LEARNS THE NEW RECORD TYPE, by the same rebuild as 095, 101, 104, 106, 107 and 109.

CREATE TABLE sync_outbox_with_store_hand_vouchers (
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
    'STORE_HAND_VOUCHER'
  )),
  CHECK (operation IN ('INSERT','UPDATE')),
  CHECK (status IN ('PENDING','IN_FLIGHT','FAILED','DEAD_LETTER','SYNCED'))
);

INSERT INTO sync_outbox_with_store_hand_vouchers (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;
ALTER TABLE sync_outbox_with_store_hand_vouchers RENAME TO sync_outbox;
CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
