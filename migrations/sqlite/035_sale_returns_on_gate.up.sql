-- Carton returns: ON GATE, and the sale return that credits the party.
--
-- A carton that comes back from a customer goes through TWO separate events, which this
-- migration is what makes representable:
--
--   DISPATCHED  --RETURN CONFIRMED-->  ON_GATE   (commercial: party credited, NO stock move)
--   ON_GATE     --STORE MOVE IN---->   WAREHOUSE (physical: stock +1, the normal store scan)
--
-- ON_GATE is a real status, not a derived one, because the carton is physically standing at
-- the gate and is in no one's stock: not the customer's any more, not the store's yet. The
-- only scan that moves it on is the ordinary Store Move In, which needs no party, no voucher
-- and no knowledge that a return ever happened.
--
-- SQLite cannot alter a CHECK constraint, so qr_master is rebuilt the same documented way
-- migration 025 rebuilt it for TO_GATE: create new, copy, drop old, rename. The migration
-- runner runs the whole file with foreign keys off, so production_events' reference to
-- qr_master survives untouched. No existing row changes status here - this is additive.
--
-- sale_returns is the credit side. One row is one returned carton, because one QR is one
-- carton - there is no header/lines split to keep, and no quantity to get wrong. Each row
-- names the exact DISPATCHED event it reverses, and the partial UNIQUE index on that column
-- is what makes a return idempotent at the database level: scanning the same carton twice
-- cannot produce a second credit, whatever the layers above do (the same technique as
-- idx_sale_vouchers_gatepass_live in migration 031) - No semicolons in comments, the
-- migration runner splits statements on them.

CREATE TABLE IF NOT EXISTS qr_master_new (
  qr_id TEXT PRIMARY KEY,
  product_variant_id TEXT NOT NULL,
  current_status TEXT NOT NULL,
  current_location_type TEXT NOT NULL DEFAULT 'UNKNOWN',
  current_location_id TEXT,
  first_event_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT,
  FOREIGN KEY (product_variant_id) REFERENCES product_variants(id),
  CHECK (current_status IN ('PRODUCED','WAREHOUSE','TO_GATE','DISPATCHED','ON_GATE','SOLD','RETURNED','DAMAGED','SCRAPPED')),
  CHECK (current_location_type IN ('FACTORY','WAREHOUSE','GATE','VEHICLE','CUSTOMER','UNKNOWN'))
);

INSERT INTO qr_master_new (qr_id, product_variant_id, current_status, current_location_type, current_location_id, first_event_id, created_at, updated_at, deleted_at, deleted_by, delete_reason)
SELECT qr_id, product_variant_id, current_status, current_location_type, current_location_id, first_event_id, created_at, updated_at, deleted_at, deleted_by, delete_reason FROM qr_master;

DROP TABLE qr_master;

ALTER TABLE qr_master_new RENAME TO qr_master;

CREATE INDEX IF NOT EXISTS idx_qr_master_current_status ON qr_master(current_status);

-- One returned carton. Valued at the rate its OWN sale voucher line was billed at, so the
-- credit can never drift from the paper bill - the rate and discount are snapshotted here
-- rather than read back through the voucher later, which would change this row's meaning if
-- the bill were ever edited. Money is integer paisa only (CLAUDE.md R15).
CREATE TABLE IF NOT EXISTS sale_returns (
  id TEXT PRIMARY KEY,
  return_number TEXT NOT NULL UNIQUE,
  party_id TEXT NOT NULL,
  return_date TEXT NOT NULL,
  qr_id TEXT NOT NULL,
  product_variant_id TEXT NOT NULL,
  dispatch_event_id TEXT NOT NULL,
  dispatch_session_id TEXT,
  sale_voucher_id TEXT,
  sale_voucher_line_item_id TEXT,
  quantity_cartons INTEGER NOT NULL DEFAULT 1 CHECK (quantity_cartons > 0),
  unit_price_paisa INTEGER NOT NULL DEFAULT 0,
  discount_per_pair_paisa INTEGER NOT NULL DEFAULT 0,
  total_amount_paisa INTEGER NOT NULL DEFAULT 0,
  remarks TEXT,
  recorded_by TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT,
  FOREIGN KEY (party_id) REFERENCES parties(id),
  FOREIGN KEY (product_variant_id) REFERENCES product_variants(id),
  FOREIGN KEY (sale_voucher_id) REFERENCES sale_vouchers(id),
  CHECK (status IN ('ACTIVE','CANCELLED'))
);

-- The idempotency guarantee: at most one live return per dispatched carton.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sale_returns_dispatch_event_live ON sale_returns(dispatch_event_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sale_returns_party_date ON sale_returns(party_id, return_date);
CREATE INDEX IF NOT EXISTS idx_sale_returns_qr ON sale_returns(qr_id);
CREATE INDEX IF NOT EXISTS idx_sale_returns_voucher ON sale_returns(sale_voucher_id);

-- Which sale return a RETURNED production_event recorded, so the audit trail runs both ways
-- (event to credit, credit to event) without either side being inferred.
ALTER TABLE production_events ADD COLUMN sale_return_id TEXT;
CREATE INDEX IF NOT EXISTS idx_production_events_sale_return ON production_events(sale_return_id) WHERE sale_return_id IS NOT NULL;
