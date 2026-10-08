-- Gatepass: an operational document that records the quantity cut from store stock for a
-- party. It is NOT a stock movement and NOT a bill.
--
--   Party + Article + Colour + Size + Qty  →  gatepasses / gatepass_lines
--
-- Creating a gatepass never touches qr_master, production_events, the stock projections
-- or any billing / ledger table. Physical movement stays with the scanners (Store Move Out,
-- Live Dispatch). Money stays with Sale Vouchers. Additive only.

CREATE TABLE IF NOT EXISTS gatepasses (
  id TEXT PRIMARY KEY,
  gatepass_number INTEGER NOT NULL UNIQUE,
  party_id TEXT NOT NULL,
  gatepass_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED',
  remarks TEXT,
  total_quantity INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cancelled_at TEXT,
  cancelled_by TEXT,
  cancel_reason TEXT,
  FOREIGN KEY (party_id) REFERENCES parties(id),
  CHECK (status IN ('CREATED','CANCELLED'))
);

-- One line per article + colour + size. product_variant_id is the canonical identity
-- (same as sale_voucher_line_items and qr_master). The snapshots keep the printed document
-- stable if Product Master is later renamed, exactly like production_events.
-- (No semicolons in comments: the migration runner splits statements on them.)
CREATE TABLE IF NOT EXISTS gatepass_lines (
  id TEXT PRIMARY KEY,
  gatepass_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  product_variant_id TEXT NOT NULL,
  article_snapshot TEXT NOT NULL,
  color_snapshot TEXT NOT NULL,
  size_snapshot TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  store_quantity_at_creation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(gatepass_id, product_variant_id),
  FOREIGN KEY (gatepass_id) REFERENCES gatepasses(id),
  FOREIGN KEY (product_variant_id) REFERENCES product_variants(id)
);

CREATE INDEX IF NOT EXISTS idx_gatepasses_party_id ON gatepasses(party_id);
CREATE INDEX IF NOT EXISTS idx_gatepasses_date ON gatepasses(gatepass_date);
CREATE INDEX IF NOT EXISTS idx_gatepasses_status ON gatepasses(status);
CREATE INDEX IF NOT EXISTS idx_gatepass_lines_gatepass_id ON gatepass_lines(gatepass_id);
CREATE INDEX IF NOT EXISTS idx_gatepass_lines_variant ON gatepass_lines(product_variant_id);
