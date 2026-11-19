-- Historical ledger archive (docs/50): a customer's ledger from the previous accounting software, kept exactly as it
-- was printed, and shown beside the live ledger on the Customer Ledger screen.
--
--   ledger_archive_statements   one customer's statement from one imported file: who, which file, which import
--                               batch, who imported it and when, and what its rows add up to
--   ledger_archive_entries      its rows, in their original order, with the original text beside what it was read as
--
-- NOT ACCOUNTING. Nothing reads these tables to work out a balance, a cash book, stock or a report. The live ledger
-- is still worked out only from sale vouchers, cash vouchers and sale returns (database/cash.ts). An archived row
-- keeps the running balance the OLD software printed, never one worked out here.
--
-- WRITTEN ONCE. A statement and its rows are inserted together by the import, and there is no way in the
-- application to change or remove them. A correction would be a new, separately audited statement.
--
-- ONE STATEMENT PER FILE PER CUSTOMER. The same file is never imported twice (source_file_hash), the same statement
-- is never stored twice for a customer (content_hash), and a retried import finds the batch it already wrote
-- (batch_id).
--
-- Money is integer paisa. The original text of every amount, date and quantity is kept too.
--
-- Replicated as the LEDGER_ARCHIVE_STATEMENT leased record under ACCOUNTS, written on the accounts computer, like a
-- cash voucher. The cloud learns the type from cloud migration 034: until it is applied, a statement waits as
-- UNKNOWN_RECORD_TYPE and nothing else is held up.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS ledger_archive_statements (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  party_id TEXT NOT NULL REFERENCES parties(id),
  original_party_code TEXT NOT NULL DEFAULT '',
  original_party_name TEXT NOT NULL DEFAULT '',
  period_from TEXT NOT NULL CHECK (length(period_from) = 10),
  period_to TEXT NOT NULL CHECK (length(period_to) = 10),
  row_count INTEGER NOT NULL CHECK (row_count > 0),
  opening_balance_paisa INTEGER NOT NULL,
  closing_balance_paisa INTEGER NOT NULL,
  total_debit_paisa INTEGER NOT NULL CHECK (total_debit_paisa >= 0),
  total_credit_paisa INTEGER NOT NULL CHECK (total_credit_paisa >= 0),
  total_quantity REAL NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  source_file_name TEXT NOT NULL CHECK (length(trim(source_file_name)) > 0),
  source_file_hash TEXT NOT NULL CHECK (length(source_file_hash) = 64),
  source_document_name TEXT,
  source_document_hash TEXT CHECK (source_document_hash IS NULL OR length(source_document_hash) = 64),
  source_document_bytes INTEGER,
  imported_by TEXT NOT NULL CHECK (length(trim(imported_by)) > 0),
  imported_at TEXT NOT NULL,
  origin_device_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_archive_statements_content ON ledger_archive_statements(party_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_ledger_archive_statements_party ON ledger_archive_statements(party_id, period_from);
CREATE INDEX IF NOT EXISTS idx_ledger_archive_statements_batch ON ledger_archive_statements(batch_id);
CREATE INDEX IF NOT EXISTS idx_ledger_archive_statements_file ON ledger_archive_statements(source_file_hash);

CREATE TABLE IF NOT EXISTS ledger_archive_entries (
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

CREATE INDEX IF NOT EXISTS idx_ledger_archive_entries_date ON ledger_archive_entries(statement_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_ledger_archive_entries_row ON ledger_archive_entries(row_hash);

-- THE OUTBOX LEARNS THE NEW RECORD TYPE, by the same rebuild as 095, 101, 104, 106, 107, 109 and 110.

CREATE TABLE sync_outbox_with_ledger_archive (
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
    'LEDGER_ARCHIVE_STATEMENT'
  )),
  CHECK (operation IN ('INSERT','UPDATE')),
  CHECK (status IN ('PENDING','IN_FLIGHT','FAILED','DEAD_LETTER','SYNCED'))
);

INSERT INTO sync_outbox_with_ledger_archive (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;
ALTER TABLE sync_outbox_with_ledger_archive RENAME TO sync_outbox;
CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
