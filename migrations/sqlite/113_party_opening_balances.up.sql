-- Suppliers' historical ledgers, and customers' and suppliers' opening balances (docs/53).
--
-- 112 IS PENDING ORDERS' customer orders (docs/52). The runner applies every file a database has not recorded, so the
-- two run in whatever order a computer meets them. Both outbox rebuilds allow all four new record types (this one
-- allows 112's CUSTOMER_ORDER and GATEPASS_ORDER_ALLOCATION, 112's allows PARTY_OPENING_BALANCE), so neither can drop
-- the other's, in either order.
--
-- 1. AN ARCHIVED STATEMENT SAYS WHOSE LEDGER IT IS AND HOW ITS BALANCE RAN.
--      ledger_side    CUSTOMER or SUPPLIER: the type of party it was imported for. Every statement imported before
--                     this is a customer's (111 imported customers only).
--      balance_rule   DEBIT_LESS_CREDIT or CREDIT_LESS_DEBIT: the rule its printed running balances follow, as the
--                     import found them. A customer's is always debit less credit.
--    Still NOT ACCOUNTING: nothing reads an archive to work out a balance.
--
-- 2. AN OPENING BALANCE, ONE PER PARTY.
--      party_opening_balances          the party's opening position NOW: POSTED with a direction, an amount and the
--                                      date it takes effect, or NONE (reversed, nothing posted since)
--      party_opening_balance_entries   every step that led there, never changed: each POST (what, from where, who,
--                                      when) and each REVERSE (what it reversed, why, who, when)
--    A customer's DEBIT is what they owe us, CREDIT an advance. A supplier's CREDIT is what we owe them, DEBIT what we
--    paid ahead. The ledgers and balance lists add a POSTED one in their own convention (database/partyOpeningBalances.ts).
--    It is NOT a voucher: no cash, stock, sale, purchase or report figure reads these tables.
--
--    NEVER OVERWRITTEN. The application has no way to change a posted amount. A correction is a REVERSE and a new
--    POST in one transaction, so another computer receives both at once (one record, one revision) and never sees two
--    opening balances for one party. party_id is UNIQUE: a party can never have two.
--
-- Replicated as the PARTY_OPENING_BALANCE leased record under ACCOUNTS, written on the accounts computer, like a cash
-- voucher. The cloud learns the type from cloud migration 037. Until it is applied a record waits as
-- UNKNOWN_RECORD_TYPE and nothing else is held up.
--
-- Money is integer paisa.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE ledger_archive_statements ADD COLUMN ledger_side TEXT NOT NULL DEFAULT 'CUSTOMER' CHECK (ledger_side IN ('CUSTOMER','SUPPLIER'));

ALTER TABLE ledger_archive_statements ADD COLUMN balance_rule TEXT NOT NULL DEFAULT 'DEBIT_LESS_CREDIT' CHECK (balance_rule IN ('DEBIT_LESS_CREDIT','CREDIT_LESS_DEBIT'));

CREATE TABLE IF NOT EXISTS party_opening_balances (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL UNIQUE REFERENCES parties(id),
  ledger_side TEXT NOT NULL CHECK (ledger_side IN ('CUSTOMER','SUPPLIER')),
  status TEXT NOT NULL CHECK (status IN ('POSTED','NONE')),
  direction TEXT CHECK (direction IS NULL OR direction IN ('DEBIT','CREDIT')),
  amount_paisa INTEGER CHECK (amount_paisa IS NULL OR amount_paisa > 0),
  effective_date TEXT CHECK (effective_date IS NULL OR length(effective_date) = 10),
  source_reference TEXT,
  archive_statement_id TEXT REFERENCES ledger_archive_statements(id),
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  origin_device_id TEXT,
  CHECK (
    (status = 'POSTED' AND direction IS NOT NULL AND amount_paisa IS NOT NULL AND effective_date IS NOT NULL AND source_reference IS NOT NULL)
    OR (status = 'NONE' AND direction IS NULL AND amount_paisa IS NULL AND effective_date IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_party_opening_balances_side ON party_opening_balances(ledger_side, status);

CREATE TABLE IF NOT EXISTS party_opening_balance_entries (
  id TEXT PRIMARY KEY,
  opening_balance_id TEXT NOT NULL REFERENCES party_opening_balances(id),
  version INTEGER NOT NULL CHECK (version > 0),
  action TEXT NOT NULL CHECK (action IN ('POST','REVERSE')),
  direction TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_paisa INTEGER NOT NULL CHECK (amount_paisa > 0),
  effective_date TEXT NOT NULL CHECK (length(effective_date) = 10),
  source_reference TEXT NOT NULL,
  archive_statement_id TEXT,
  note TEXT,
  reason TEXT,
  request_id TEXT NOT NULL,
  recorded_by TEXT NOT NULL CHECK (length(trim(recorded_by)) > 0),
  recorded_at TEXT NOT NULL,
  CHECK (action = 'POST' OR (reason IS NOT NULL AND length(trim(reason)) > 0)),
  UNIQUE (opening_balance_id, version),
  UNIQUE (request_id, action)
);

CREATE INDEX IF NOT EXISTS idx_party_opening_balance_entries_parent ON party_opening_balance_entries(opening_balance_id, version);

-- THE OUTBOX LEARNS THE NEW RECORD TYPE, by the same rebuild as 095, 101, 104, 106, 107, 109, 110 and 111. It also
-- allows Pending Orders' CUSTOMER_ORDER and GATEPASS_ORDER_ALLOCATION (112), so the two branches can merge.

CREATE TABLE sync_outbox_with_opening_balances (
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
    'PARTY_OPENING_BALANCE'
  )),
  CHECK (operation IN ('INSERT','UPDATE')),
  CHECK (status IN ('PENDING','IN_FLIGHT','FAILED','DEAD_LETTER','SYNCED'))
);

INSERT INTO sync_outbox_with_opening_balances (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;
ALTER TABLE sync_outbox_with_opening_balances RENAME TO sync_outbox;
CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
