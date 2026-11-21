-- Purchase bills travel (docs/54): the PURCHASE_VOUCHER leased record, under ACCOUNTS.
--
-- A supplier's balance is its opening balance, plus its purchase bills, less what was paid (cash vouchers) and its
-- posted claims. Cash vouchers and opening balances already travel under ACCOUNTS. Purchase bills did not, and any
-- computer could write one: a bill entered anywhere but the accounts computer never reached the only screen that
-- shows supplier balances. From this release a bill is written only on the computer holding ACCOUNTS (leaseChannels.ts)
-- and travels from it, whole, by revision, with its lines.
--
-- A PURCHASE BILL MOVES NOTHING ELSE. It writes no stock movement, cash, production or claim: purchases.ts writes
-- purchase_vouchers and purchase_voucher_line_items only, and nothing reads them but the supplier ledger and balances.
-- A bill arriving on another computer therefore changes nothing there but those two screens' figures.
--
-- NOTHING IS SENT FOR BILLS ALREADY STORED. Capture triggers are installed after migrations, so only bills written or
-- changed from now on are marked. Older bills stay on the computer that holds them until a separate, authorised
-- backfill (docs/54). Supplier screens stay on the ACCOUNTS holder only (ledgerVisibility.ts) until then.
--
-- THE OUTBOX LEARNS THE NEW TYPE, by the same rebuild as 113. Every type 111-114 allowed stays allowed.
-- The cloud learns it from cloud migration 038. Until that is applied a bill waits as UNKNOWN_RECORD_TYPE and nothing
-- else is held up.

CREATE TABLE sync_outbox_with_purchase_vouchers (
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
    'PURCHASE_VOUCHER'
  )),
  CHECK (operation IN ('INSERT','UPDATE')),
  CHECK (status IN ('PENDING','IN_FLIGHT','FAILED','DEAD_LETTER','SYNCED'))
);

INSERT INTO sync_outbox_with_purchase_vouchers (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;
ALTER TABLE sync_outbox_with_purchase_vouchers RENAME TO sync_outbox;
CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
