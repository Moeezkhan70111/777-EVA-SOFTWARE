-- AN ARCHIVED STATEMENT TRAVELS IN PAGES (docs/50, cloud migration 041).
--
-- Until now a statement travelled as ONE leased record holding every row. The cloud refuses a record over 256 KB
-- (013, RECORD_TOO_LARGE), which is about 480 rows, and the import accepts up to 5,000 rows a party. So a long ledger
-- imported on the accounts computer was refused, parked as a dead letter, and never reached any other computer.
--
-- From here a statement travels as its HEADER (ledger_archive_statements, no rows) and its rows in PAGES of 50
-- (LEDGER_ARCHIVE_PAGE_ROWS in @erp/domain), each page its own leased record, LEDGER_ARCHIVE_ENTRY_PAGE, under
-- ACCOUNTS. A receiver shows a statement only once every row of it is here (row_count, ARCHIVE_STATEMENT_COMPLETE_SQL).
--
-- What this does, on every computer:
--   1. ledger_archive_entry_pages: one row per page, its id the statement's id and its number ("<id>:p<n>"), the
--      same rule as ledgerArchivePageId in @erp/domain, so every computer that already holds a statement makes the
--      pages the writer will send, with the same ids.
--   2. ledger_archive_entries is rebuilt with page_id NOT NULL. Every row and every value is kept, and only page_id is new.
--   3. On the computer holding ACCOUNTS only: every statement and every page is marked to be sent, under the epoch it
--      holds now, like a capture trigger marks a change. Elsewhere nothing is marked (a receiver sends nothing).
--   4. A statement revision built the old way and never delivered (a dead letter RECORD_TOO_LARGE, or one still
--      waiting) is RETIRED: status SYNCED with a note saying so, as the test-state clear retires rows. It is kept,
--      not deleted. Sending it could never help: a 117 receiver refuses a statement carrying rows. Its record is sent
--      again by step 3, as a new revision.
--   5. sync_outbox's type check gains LEDGER_ARCHIVE_ENTRY_PAGE.
--
-- Foreign keys are off during migrations (the runner), so the rebuilds below do not cascade.

CREATE TABLE IF NOT EXISTS ledger_archive_entry_pages (
  id TEXT PRIMARY KEY,
  statement_id TEXT NOT NULL REFERENCES ledger_archive_statements(id),
  page_number INTEGER NOT NULL CHECK (page_number > 0),
  first_sequence INTEGER NOT NULL CHECK (first_sequence > 0),
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= first_sequence),
  row_count INTEGER NOT NULL CHECK (row_count > 0),
  CHECK (id = statement_id || ':p' || page_number),
  UNIQUE (statement_id, page_number)
);

CREATE TEMP TABLE archive_entry_positions AS
SELECT e.id AS entry_id, e.statement_id, e.sequence,
       ((ROW_NUMBER() OVER (PARTITION BY e.statement_id ORDER BY e.sequence) - 1) / 50) + 1 AS page_number
FROM ledger_archive_entries e;

INSERT INTO ledger_archive_entry_pages (id, statement_id, page_number, first_sequence, last_sequence, row_count)
SELECT statement_id || ':p' || page_number, statement_id, page_number, MIN(sequence), MAX(sequence), COUNT(*)
FROM archive_entry_positions
GROUP BY statement_id, page_number;

CREATE TABLE ledger_archive_entries_paged (
  id TEXT PRIMARY KEY,
  statement_id TEXT NOT NULL REFERENCES ledger_archive_statements(id),
  page_id TEXT NOT NULL REFERENCES ledger_archive_entry_pages(id),
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
  CHECK (page_id LIKE statement_id || ':p%'),
  UNIQUE (statement_id, sequence)
);

INSERT INTO ledger_archive_entries_paged (
  id, statement_id, page_id, sequence, entry_date, original_date_text, voucher_number, transaction_type, bill_number,
  description, quantity_text, quantity, debit_paisa, credit_paisa, balance_paisa, debit_text, credit_text, balance_text, row_hash
)
SELECT e.id, e.statement_id, p.statement_id || ':p' || p.page_number, e.sequence, e.entry_date, e.original_date_text, e.voucher_number,
       e.transaction_type, e.bill_number, e.description, e.quantity_text, e.quantity, e.debit_paisa, e.credit_paisa, e.balance_paisa,
       e.debit_text, e.credit_text, e.balance_text, e.row_hash
FROM ledger_archive_entries e
JOIN archive_entry_positions p ON p.entry_id = e.id
ORDER BY e.rowid;

DROP TABLE archive_entry_positions;
DROP TABLE ledger_archive_entries;
ALTER TABLE ledger_archive_entries_paged RENAME TO ledger_archive_entries;
CREATE INDEX IF NOT EXISTS idx_ledger_archive_entries_date ON ledger_archive_entries(statement_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_ledger_archive_entries_row ON ledger_archive_entries(row_hash);
CREATE INDEX IF NOT EXISTS idx_ledger_archive_entries_page ON ledger_archive_entries(page_id);

INSERT INTO sync_dirty_records (aggregate_type, record_id, lease_epoch, marked_at)
SELECT 'LEDGER_ARCHIVE_STATEMENT', s.id, l.epoch, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM ledger_archive_statements s
JOIN sync_domain_leases l ON l.domain = 'ACCOUNTS' AND l.epoch > 0
 AND l.holder_device_id = (SELECT setting_value FROM app_settings WHERE setting_key = 'device.id')
WHERE 1
ON CONFLICT (aggregate_type, record_id) DO UPDATE SET lease_epoch = excluded.lease_epoch, marked_at = excluded.marked_at;

INSERT INTO sync_dirty_records (aggregate_type, record_id, lease_epoch, marked_at)
SELECT 'LEDGER_ARCHIVE_ENTRY_PAGE', p.id, l.epoch, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM ledger_archive_entry_pages p
JOIN sync_domain_leases l ON l.domain = 'ACCOUNTS' AND l.epoch > 0
 AND l.holder_device_id = (SELECT setting_value FROM app_settings WHERE setting_key = 'device.id')
WHERE 1
ON CONFLICT (aggregate_type, record_id) DO UPDATE SET lease_epoch = excluded.lease_epoch, marked_at = excluded.marked_at;

UPDATE sync_outbox
   SET status = 'SYNCED',
       lock_token = NULL,
       last_error = 'RETIRED by local 117: a statement sent whole, with its rows, is never sent. It goes again as its header and its pages.'
                    || COALESCE(' Was: ' || status || ', ' || last_error, ' Was: ' || status),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE aggregate_type = 'LEDGER_ARCHIVE_STATEMENT' AND status <> 'SYNCED';

CREATE TABLE sync_outbox_with_archive_pages (
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
    'SALE_RETURN'
  )),
  CHECK (operation IN ('INSERT','UPDATE')),
  CHECK (status IN ('PENDING','IN_FLIGHT','FAILED','DEAD_LETTER','SYNCED'))
);

INSERT INTO sync_outbox_with_archive_pages (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;
ALTER TABLE sync_outbox_with_archive_pages RENAME TO sync_outbox;
CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
