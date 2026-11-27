-- EMPLOYEES AND THEIR SALARIES (owner, 27 Nov 2026: "add a new card on dashboard named as Salaries ... add Employee ...
-- set its salary").
--
--   employees    one person who works here: name, what they do, phone, the day they joined, the monthly salary in
--                integer paisa (R15), and whether they still work here. Written on the computer that holds ACCOUNTS
--                (PC1), as cash vouchers are, and travelling as the EMPLOYEE leased record (cloud 044). Read
--                everywhere.
--
-- Two working employees cannot have the same name (a unique index on the name while ACTIVE), so one person is never
-- added twice by a double click or a second computer. Add something to tell two people apart, like ALI (CUTTING).
--
-- No stock, cash, ledger or order figure reads this table.
--
-- THE OUTBOX LEARNS ONE TYPE, by the same rebuild as 121. Every type it allowed stays allowed. Until cloud 044 is
-- applied an employee waits as UNKNOWN_RECORD_TYPE and nothing else is held up.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  work TEXT,
  phone TEXT,
  monthly_salary_paisa INTEGER NOT NULL,
  joined_on TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  origin_device_id TEXT,
  CHECK (TRIM(name) <> ''),
  CHECK (monthly_salary_paisa > 0),
  CHECK (status IN ('ACTIVE','LEFT'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_working_name ON employees(UPPER(TRIM(name))) WHERE status = 'ACTIVE';

CREATE TABLE sync_outbox_with_employees (
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
    'ARTICLE_COLOR_REQUEST',
    'EMPLOYEE'
  )),
  CHECK (operation IN ('INSERT','UPDATE')),
  CHECK (status IN ('PENDING','IN_FLIGHT','FAILED','DEAD_LETTER','SYNCED'))
);

INSERT INTO sync_outbox_with_employees (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;
ALTER TABLE sync_outbox_with_employees RENAME TO sync_outbox;
CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
