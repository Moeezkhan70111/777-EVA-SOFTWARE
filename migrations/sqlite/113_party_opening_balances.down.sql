-- Undoes 113. It REFUSES, and the run rolls back whole, while anything 113 made possible is stored:
--   a supplier's archived statement     without ledger_side it would read as a customer's
--   any opening balance                  dropping it would change a live balance, silently
-- Each refusal is a CHECK the count must pass. A queued PARTY_OPENING_BALANCE cannot be stored in the old outbox
-- either, so it stops this too. Pending Orders' two types (local 112) stay allowed: this undoes 113 only.

CREATE TABLE undo_113_guard (what TEXT NOT NULL, n INTEGER NOT NULL CHECK (n = 0));
INSERT INTO undo_113_guard (what, n) SELECT 'supplier archive statements', COUNT(*) FROM ledger_archive_statements WHERE ledger_side = 'SUPPLIER';
INSERT INTO undo_113_guard (what, n) SELECT 'opening balances', COUNT(*) FROM party_opening_balances;
DROP TABLE undo_113_guard;

CREATE TABLE sync_outbox_without_opening_balances (
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
    'LEDGER_ARCHIVE_STATEMENT',
    'CUSTOMER_ORDER','GATEPASS_ORDER_ALLOCATION'
  )),
  CHECK (operation IN ('INSERT','UPDATE')),
  CHECK (status IN ('PENDING','IN_FLIGHT','FAILED','DEAD_LETTER','SYNCED'))
);

INSERT INTO sync_outbox_without_opening_balances (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;
ALTER TABLE sync_outbox_without_opening_balances RENAME TO sync_outbox;
CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);

DROP TABLE IF EXISTS party_opening_balance_entries;
DROP TABLE IF EXISTS party_opening_balances;
ALTER TABLE ledger_archive_statements DROP COLUMN balance_rule;
ALTER TABLE ledger_archive_statements DROP COLUMN ledger_side;
