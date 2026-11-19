-- Customer orders and what gatepasses dispatched against them (docs/52).
--
--   customer_orders                    ORD-000014: a party's order, its day, its note, OPEN or CANCELLED
--   customer_order_lines               one product (article + colour + size) and the cartons ordered
--   gatepass_order_allocations         one per gatepass: which order lines its cartons were counted against
--   gatepass_order_allocation_lines    one gatepass line's share of one order line
--
-- AN ORDER MOVES NOTHING. No stock, no money, no ledger. Gatepass stays the document that does all three.
-- pending = ordered - (allocation lines naming the order line that are not reversed), computed, never stored.
--
-- THE ALLOCATION IS PERSISTED, written by the same transaction that makes the gatepass and reversed by the same
-- transaction that cancels it, so it survives a restart and travels as a record of its own. It is never worked out
-- again from what a screen shows. Each gatepass has at most one allocation (UNIQUE gatepass_id), so a retried Create
-- cannot allocate twice. An allocation line that is reversed is kept, with when: a later re-allocation adds new lines.
--
-- AN ORDER LINE IS NEVER DELETED. An edit that takes a product off the order marks the line REMOVED, so an allocation
-- that names it still finds it. An edit may not take a line below what has already been dispatched against it.
--
-- Replicated as two leased records under SALES_DISPATCH, the gatepass's own lease: CUSTOMER_ORDER (the order with its
-- lines) and GATEPASS_ORDER_ALLOCATION (the allocation with its lines). The cloud learns both types from cloud
-- migration 036: until it is applied they wait as UNKNOWN_RECORD_TYPE and nothing else is held up.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS customer_orders (
  id TEXT PRIMARY KEY,
  order_number INTEGER NOT NULL UNIQUE,
  business_date TEXT NOT NULL CHECK (length(business_date) = 10),
  party_id TEXT NOT NULL REFERENCES parties(id),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CANCELLED')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  cancelled_by TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  origin_device_id TEXT,
  CHECK (status = 'OPEN' OR length(trim(COALESCE(cancel_reason, ''))) > 0)
);

CREATE INDEX IF NOT EXISTS idx_customer_orders_party ON customer_orders(party_id, status);
CREATE INDEX IF NOT EXISTS idx_customer_orders_date ON customer_orders(business_date, order_number);

CREATE TABLE IF NOT EXISTS customer_order_lines (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES customer_orders(id),
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  product_variant_id TEXT NOT NULL REFERENCES product_variants(id),
  article_snapshot TEXT NOT NULL,
  color_snapshot TEXT NOT NULL,
  size_snapshot TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REMOVED')),
  UNIQUE (order_id, line_no),
  UNIQUE (order_id, product_variant_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_order_lines_variant ON customer_order_lines(product_variant_id);

CREATE TABLE IF NOT EXISTS gatepass_order_allocations (
  id TEXT PRIMARY KEY,
  gatepass_id TEXT NOT NULL UNIQUE REFERENCES gatepasses(id),
  party_id TEXT NOT NULL REFERENCES parties(id),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVERSED')),
  allocated_quantity INTEGER NOT NULL DEFAULT 0 CHECK (allocated_quantity >= 0),
  unallocated_quantity INTEGER NOT NULL DEFAULT 0 CHECK (unallocated_quantity >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reversed_by TEXT,
  reversed_at TEXT,
  reverse_reason TEXT,
  origin_device_id TEXT
);

CREATE TABLE IF NOT EXISTS gatepass_order_allocation_lines (
  id TEXT PRIMARY KEY,
  allocation_id TEXT NOT NULL REFERENCES gatepass_order_allocations(id),
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  gatepass_line_id TEXT NOT NULL REFERENCES gatepass_lines(id),
  order_line_id TEXT NOT NULL REFERENCES customer_order_lines(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  allocated_at TEXT NOT NULL,
  reversed_at TEXT,
  UNIQUE (allocation_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_gatepass_order_allocation_lines_order_line ON gatepass_order_allocation_lines(order_line_id, reversed_at);
CREATE INDEX IF NOT EXISTS idx_gatepass_order_allocation_lines_gatepass_line ON gatepass_order_allocation_lines(gatepass_line_id);

-- THE OUTBOX LEARNS THE TWO NEW RECORD TYPES, by the same rebuild as 095, 101, 104, 106, 107, 109 and 110.
-- LEDGER_ARCHIVE_STATEMENT (local 111) and PARTY_OPENING_BALANCE (local 113) are allowed here too, so this rebuild
-- keeps them whatever order a computer meets 112 and 113 in: a computer that ran 113 first and then 112 would otherwise
-- lose PARTY_OPENING_BALANCE, or refuse to start with one still queued (tested 19 Nov 2026).

CREATE TABLE sync_outbox_with_customer_orders (
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

INSERT INTO sync_outbox_with_customer_orders (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;
ALTER TABLE sync_outbox_with_customer_orders RENAME TO sync_outbox;
CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
