-- Undoes 116. It REFUSES, and the run rolls back whole, while any claim request, rejection or claim posted from a
-- request is stored, or while any of the new record types is still queued: undoing would drop the store's requests
-- or Accounts' answers, which are business records. With none, party_claims returns to its 076 shape with every row.

CREATE TABLE undo_116_guard (n INTEGER NOT NULL CHECK (n = 0));
INSERT INTO undo_116_guard (n)
SELECT (SELECT COUNT(*) FROM party_claim_requests) + (SELECT COUNT(*) FROM party_claim_rejections)
     + (SELECT COUNT(*) FROM party_claims WHERE request_id IS NOT NULL);
DROP TABLE undo_116_guard;

CREATE TABLE party_claims_without_requests (
  id TEXT PRIMARY KEY,
  claim_number TEXT NOT NULL UNIQUE,
  party_id TEXT NOT NULL,
  party_role TEXT NOT NULL,
  program_id TEXT NOT NULL,
  upper_line_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity_pairs INTEGER NOT NULL,
  rate_paisa INTEGER NOT NULL,
  amount_paisa INTEGER NOT NULL,
  reason TEXT NOT NULL,
  claim_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'POSTED',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reversed_by TEXT,
  reversed_at TEXT,
  reversal_reason TEXT,
  origin_device_id TEXT,
  FOREIGN KEY (party_id) REFERENCES parties(id),
  FOREIGN KEY (program_id) REFERENCES machine_programs(id),
  FOREIGN KEY (upper_line_id) REFERENCES machine_program_upper_lines(id),
  FOREIGN KEY (item_id) REFERENCES inventory_items(id),
  CHECK (party_role IN ('SUPPLIER','MACHINE','PACKING')),
  CHECK (status IN ('POSTED','REVERSED')),
  CHECK (quantity_pairs > 0 AND rate_paisa > 0),
  CHECK (amount_paisa = quantity_pairs * rate_paisa),
  CHECK (TRIM(reason) <> '')
);

INSERT INTO party_claims_without_requests (
  id, claim_number, party_id, party_role, program_id, upper_line_id, item_id, quantity_pairs, rate_paisa, amount_paisa,
  reason, claim_date, status, created_by, created_at, reversed_by, reversed_at, reversal_reason, origin_device_id
)
SELECT
  id, claim_number, party_id, party_role, program_id, upper_line_id, item_id, quantity_pairs, rate_paisa, amount_paisa,
  reason, claim_date, status, created_by, created_at, reversed_by, reversed_at, reversal_reason, origin_device_id
FROM party_claims
ORDER BY rowid;

DROP TABLE party_claims;
ALTER TABLE party_claims_without_requests RENAME TO party_claims;
CREATE INDEX IF NOT EXISTS idx_party_claims_party ON party_claims(party_id, claim_date);
CREATE INDEX IF NOT EXISTS idx_party_claims_program ON party_claims(program_id);

DROP TABLE party_claim_rejections;
DROP TABLE party_claim_requests;

CREATE TABLE sync_outbox_without_claims (
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

INSERT INTO sync_outbox_without_claims (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;
ALTER TABLE sync_outbox_without_claims RENAME TO sync_outbox;
CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
