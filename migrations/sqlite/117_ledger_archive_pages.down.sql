-- Undo 117: rows without pages, the 116 outbox.
--
-- REFUSED once any page has been queued to send (the 116 outbox has no place for it, and the cloud may hold it). Every
-- archived row and every value is kept: only page_id and the pages table go. Statement revisions 117 retired stay
-- retired, with their note, since sending them whole is exactly what failed. Marks 117 made are left, harmless: a 116
-- build sends a marked statement whole again, as it always did.

CREATE TABLE undo_117_guard (n INTEGER NOT NULL CHECK (n = 0));
INSERT INTO undo_117_guard (n) SELECT COUNT(*) FROM sync_outbox WHERE aggregate_type = 'LEDGER_ARCHIVE_ENTRY_PAGE';
DROP TABLE undo_117_guard;

DELETE FROM sync_dirty_records WHERE aggregate_type = 'LEDGER_ARCHIVE_ENTRY_PAGE';

CREATE TABLE ledger_archive_entries_unpaged (
  id TEXT PRIMARY KEY,
  statement_id TEXT NOT NULL REFERENCES ledger_archive_statements(id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  entry_date TEXT NOT NULL CHECK (length(entry_date) = 10),
  original_date_text TEXT NOT NULL,
  voucher_number TEXT NOT NULL DEFAULT '',
  transaction_type TEXT NOT NULL DEFAULT '',
  bill_number TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  quantity_text TEXT NOT NULL DEFAULT '',
  quantity REAL,
  debit_paisa INTEGER NOT NULL CHECK (debit_paisa >= 0),
  credit_paisa INTEGER NOT NULL CHECK (credit_paisa >= 0),
  balance_paisa INTEGER NOT NULL,
  debit_text TEXT NOT NULL DEFAULT '',
  credit_text TEXT NOT NULL DEFAULT '',
  balance_text TEXT NOT NULL DEFAULT '',
  row_hash TEXT NOT NULL CHECK (length(row_hash) = 64),
  CHECK (debit_paisa = 0 OR credit_paisa = 0),
  UNIQUE (statement_id, sequence)
);

INSERT INTO ledger_archive_entries_unpaged (
  id, statement_id, sequence, entry_date, original_date_text, voucher_number, transaction_type, bill_number,
  description, quantity_text, quantity, debit_paisa, credit_paisa, balance_paisa, debit_text, credit_text, balance_text, row_hash
)
SELECT id, statement_id, sequence, entry_date, original_date_text, voucher_number, transaction_type, bill_number,
       description, quantity_text, quantity, debit_paisa, credit_paisa, balance_paisa, debit_text, credit_text, balance_text, row_hash
FROM ledger_archive_entries
ORDER BY rowid;

DROP TABLE ledger_archive_entries;
ALTER TABLE ledger_archive_entries_unpaged RENAME TO ledger_archive_entries;
CREATE INDEX IF NOT EXISTS idx_ledger_archive_entries_date ON ledger_archive_entries(statement_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_ledger_archive_entries_row ON ledger_archive_entries(row_hash);
DROP TABLE ledger_archive_entry_pages;

CREATE TABLE sync_outbox_without_archive_pages (
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
    'CUSTOMER_ORDER','GATEPASS_ORDER_ALLOCATION',
    'PARTY_OPENING_BALANCE',
    'PURCHASE_VOUCHER',
    'PARTY_CLAIM_REQUEST','PARTY_CLAIM','PARTY_CLAIM_REJECTION',
    'SALE_RETURN'
  )),
  CHECK (operation IN ('INSERT','UPDATE')),
  CHECK (status IN ('PENDING','IN_FLIGHT','FAILED','DEAD_LETTER','SYNCED'))
);

INSERT INTO sync_outbox_without_archive_pages (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;
ALTER TABLE sync_outbox_without_archive_pages RENAME TO sync_outbox;
CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
