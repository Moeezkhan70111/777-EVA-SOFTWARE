-- Claims are asked for by the store and posted by Accounts (docs/55).
--
-- Until now closing a machine program on the store computer POSTED the claim, at an amount the store typed, straight
-- onto the supplier's or contractor's ledger, on that computer only. Machine programs do not travel, so the accounts
-- computer never saw a claim, and an accounting figure was decided off the accounts computer.
--
-- From this release:
--
--   party_claim_requests     the STORE's record, written in the same transaction as the program's closure. How many
--                            pairs of which material went missing on which program, against whom, and why. No money.
--                            It counts towards the closing rule exactly as a claim did (claimed_pairs). It travels as
--                            the PARTY_CLAIM_REQUEST leased record under the store's lease.
--   party_claims             ACCOUNTS' record: a request priced and posted, or an older claim. Only POSTED claims
--                            stand on a ledger. A reversal keeps the row with who reversed it and why. It travels as
--                            PARTY_CLAIM under ACCOUNTS.
--   party_claim_rejections   ACCOUNTS' answer that nothing is claimed for a request, with why. Travels as
--                            PARTY_CLAIM_REJECTION under ACCOUNTS.
--
-- A request and its answers carry the program's code and the material's name as text, because neither the program nor
-- its lines exist on the accounts computer. program_id and upper_line_id are kept as references to the store's records
-- for tracing, without a foreign key, so a row can stand on a computer that never had the program.
--
-- party_claims IS REBUILT (SQLite cannot drop a foreign key): the same columns and the same rows, plus request_id,
-- program_code and material_name, which are NULL on every claim posted before this release. Those older claims keep
-- their number, amount, party and status, so every ledger reads exactly what it read before.
--
-- A request is posted at most once at a time: a partial unique index refuses a second POSTED claim for one request,
-- so a double click, a retry or two deliveries can never post it twice. A rejection is one row per request (UNIQUE).
--
-- No stock, cash, sale, purchase or production figure reads these tables. The closing rule and cut size are unchanged.
--
-- THE OUTBOX LEARNS FOUR TYPES, by the same rebuild as 115. Every type 111-115 allowed stays allowed.
--   PARTY_CLAIM_REQUEST, PARTY_CLAIM, PARTY_CLAIM_REJECTION    cloud migration 039
--   SALE_RETURN    a customer's carton return credit, under the sales lease (docs/55). sale_returns itself needs no
--                  change: it is written only on the sales holder, so its own numbering stays unique. Cloud 040.
-- Until a type's cloud migration is applied its records wait as UNKNOWN_RECORD_TYPE and nothing else is held up.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS party_claim_requests (
  id TEXT PRIMARY KEY,
  request_number TEXT NOT NULL UNIQUE,
  party_id TEXT NOT NULL,
  party_role TEXT NOT NULL,
  program_id TEXT NOT NULL,
  program_code TEXT NOT NULL,
  upper_line_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  material_name TEXT NOT NULL,
  quantity_pairs INTEGER NOT NULL,
  reason TEXT NOT NULL,
  request_date TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  origin_device_id TEXT,
  FOREIGN KEY (party_id) REFERENCES parties(id),
  FOREIGN KEY (item_id) REFERENCES inventory_items(id),
  CHECK (party_role IN ('SUPPLIER','MACHINE','PACKING')),
  CHECK (quantity_pairs > 0),
  CHECK (TRIM(reason) <> ''),
  CHECK (TRIM(program_code) <> '' AND TRIM(material_name) <> '')
);

CREATE INDEX IF NOT EXISTS idx_party_claim_requests_program ON party_claim_requests(program_id, upper_line_id);
CREATE INDEX IF NOT EXISTS idx_party_claim_requests_party ON party_claim_requests(party_id, request_date);

CREATE TABLE IF NOT EXISTS party_claim_rejections (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  rejected_by TEXT NOT NULL,
  rejected_at TEXT NOT NULL,
  origin_device_id TEXT,
  FOREIGN KEY (request_id) REFERENCES party_claim_requests(id),
  CHECK (TRIM(reason) <> '')
);

CREATE TABLE IF NOT EXISTS party_claims_with_requests (
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
  request_id TEXT,
  program_code TEXT,
  material_name TEXT,
  FOREIGN KEY (party_id) REFERENCES parties(id),
  FOREIGN KEY (item_id) REFERENCES inventory_items(id),
  FOREIGN KEY (request_id) REFERENCES party_claim_requests(id),
  CHECK (party_role IN ('SUPPLIER','MACHINE','PACKING')),
  CHECK (status IN ('POSTED','REVERSED')),
  CHECK (quantity_pairs > 0 AND rate_paisa > 0),
  CHECK (amount_paisa = quantity_pairs * rate_paisa),
  CHECK (TRIM(reason) <> ''),
  CHECK (status <> 'REVERSED' OR (reversed_by IS NOT NULL AND reversed_at IS NOT NULL AND TRIM(COALESCE(reversal_reason, '')) <> ''))
);

INSERT INTO party_claims_with_requests (
  id, claim_number, party_id, party_role, program_id, upper_line_id, item_id, quantity_pairs, rate_paisa, amount_paisa,
  reason, claim_date, status, created_by, created_at, reversed_by, reversed_at, reversal_reason, origin_device_id
)
SELECT
  id, claim_number, party_id, party_role, program_id, upper_line_id, item_id, quantity_pairs, rate_paisa, amount_paisa,
  reason, claim_date, status, created_by, created_at, reversed_by, reversed_at, reversal_reason, origin_device_id
FROM party_claims
ORDER BY rowid;

DROP TABLE party_claims;
ALTER TABLE party_claims_with_requests RENAME TO party_claims;
CREATE INDEX IF NOT EXISTS idx_party_claims_party ON party_claims(party_id, claim_date);
CREATE INDEX IF NOT EXISTS idx_party_claims_program ON party_claims(program_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_party_claims_one_posted_per_request ON party_claims(request_id) WHERE request_id IS NOT NULL AND status = 'POSTED';
CREATE INDEX IF NOT EXISTS idx_party_claims_request ON party_claims(request_id);

CREATE TABLE sync_outbox_with_claims (
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

INSERT INTO sync_outbox_with_claims (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;
ALTER TABLE sync_outbox_with_claims RENAME TO sync_outbox;
CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
