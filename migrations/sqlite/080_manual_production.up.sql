-- MANUAL PRODUCTION -- cartons recorded by typing them in, with no carton QR (owner, 2026-10-14).
--
--   Manual Production  MACHINE 1  .  SK6 7/10 RED  .  10 DOZEN
--     ->  manual_production_entries        MAN-000001, 20 cartons, on MACHINE 1's program for today
--     ->  stock_projection_by_variant      +20
--     ->  stock_projection_by_location     WAREHOUSE +20 (Current Stock)
--
-- One row per entry, written once in the same transaction as the stock it adds, and never updated
-- or deleted -- it is the history that stock came from. The Contractor Ledger and Reconciliation read
-- it beside the carton QRs. The product, size and colour are kept as they read when it was saved.
--
-- request_id is the screen's own key for one press of Save: a retry of the same press finds the
-- entry already made instead of adding the stock twice.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS manual_production_entries (
  id TEXT PRIMARY KEY,
  entry_number INTEGER NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE,
  machine_program_id TEXT NOT NULL REFERENCES machine_programs(id),
  machine_id TEXT NOT NULL REFERENCES machines(id),
  article_size_id TEXT NOT NULL REFERENCES article_sizes(id),
  product_variant_id TEXT NOT NULL REFERENCES product_variants(id),
  article TEXT NOT NULL,
  size TEXT NOT NULL,
  color TEXT NOT NULL,
  cartons INTEGER NOT NULL CHECK (cartons > 0),
  stock_location_id TEXT NOT NULL,
  entry_ts TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_manual_production_entries_ts ON manual_production_entries(entry_ts);

CREATE INDEX IF NOT EXISTS idx_manual_production_entries_program ON manual_production_entries(machine_program_id);
