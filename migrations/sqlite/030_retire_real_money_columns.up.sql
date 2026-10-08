-- Final step of the REAL rupees -> INTEGER paisa migration (CLAUDE.md R15)
-- Every column below has been dual-written since migration 029_money_paisa_columns, every
-- application read/write has moved to the *_paisa sibling (verified with zero
-- checkMoneyDrift violations before this migration was written), and the one write-path query
-- that still compared REAL values directly (createPartyPriceRangeDiscount's duplicate/overlap
-- detection) was moved to paisa in the same change that introduced this migration - No
-- semicolons anywhere in this comment block, not even as English punctuation - the migration
-- runner splits statements on them
--
-- report_daily_summary.inventory_value_cost/inventory_value_sales are deliberately NOT touched
-- here - they have no reader or writer anywhere in the codebase, are unrelated to any active
-- R15 money path, and retiring them was explicitly left out of scope for this migration

ALTER TABLE article_sizes DROP COLUMN cost_price;
ALTER TABLE article_sizes DROP COLUMN selling_price;

ALTER TABLE product_variants DROP COLUMN cost_price;
ALTER TABLE product_variants DROP COLUMN selling_price;

ALTER TABLE parties DROP COLUMN balance_limit;

ALTER TABLE inventory_items DROP COLUMN cost_price;

ALTER TABLE party_product_group_discounts DROP COLUMN discount_per_pair;
ALTER TABLE party_article_series_discounts DROP COLUMN discount_per_pair;
ALTER TABLE party_article_discounts DROP COLUMN discount_per_pair;

-- party_price_range_discounts cannot use plain DROP COLUMN for start_price/end_price: they
-- participate in the table's inline UNIQUE(party_id, start_price, end_price) constraint, and
-- SQLite refuses to drop a column that's part of a UNIQUE constraint's index (unlike the
-- self-referencing single-column CHECKs on discount_per_pair/start_price/end_price above, which
-- SQLite drops automatically). The constraint itself can't be altered either - SQLite has no
-- ALTER TABLE DROP CONSTRAINT - so the table is rebuilt instead, same technique already used by
-- migrations/sqlite/019_supplier_workflow for parties: create the new shape, copy every row
-- across untouched, drop the old table, rename the new one into place. The UNIQUE constraint is
-- recreated against the paisa columns, preserving the exact same duplicate-price-range rule
-- createPartyPriceRangeDiscount() already enforces in application code
CREATE TABLE party_price_range_discounts_new (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL,
  discount_per_pair_paisa INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  start_price_paisa INTEGER,
  end_price_paisa INTEGER,
  UNIQUE(party_id, start_price_paisa, end_price_paisa),
  FOREIGN KEY (party_id) REFERENCES parties(id)
);

INSERT INTO party_price_range_discounts_new (id, party_id, discount_per_pair_paisa, created_at, updated_at, deleted_at, start_price_paisa, end_price_paisa)
SELECT id, party_id, discount_per_pair_paisa, created_at, updated_at, deleted_at, start_price_paisa, end_price_paisa
FROM party_price_range_discounts;

DROP TABLE party_price_range_discounts;

ALTER TABLE party_price_range_discounts_new RENAME TO party_price_range_discounts;

ALTER TABLE sale_vouchers DROP COLUMN total_amount;

ALTER TABLE sale_voucher_line_items DROP COLUMN unit_price;
ALTER TABLE sale_voucher_line_items DROP COLUMN discount;
ALTER TABLE sale_voucher_line_items DROP COLUMN discount_per_pair;
ALTER TABLE sale_voucher_line_items DROP COLUMN total_price;

-- cash_vouchers and cash_voucher_lines cannot use plain DROP COLUMN for receipt_amount/
-- payment_amount either: each table has a CHECK spanning BOTH columns together (the
-- mutual-exclusivity rule - a line is a receipt or a payment, never both), and SQLite only
-- auto-removes a CHECK constraint on DROP COLUMN when it references just the column being
-- dropped and no other. Same rebuild technique as party_price_range_discounts above, with the
-- mutual-exclusivity CHECK carried over onto the paisa columns unchanged in meaning.
CREATE TABLE cash_vouchers_new (
  id TEXT PRIMARY KEY,
  voucher_number INTEGER NOT NULL UNIQUE,
  party_id TEXT NOT NULL,
  voucher_date TEXT NOT NULL,
  mode_of_transfer TEXT NOT NULL DEFAULT 'Cash',
  description TEXT NOT NULL,
  receipt_amount_paisa INTEGER,
  payment_amount_paisa INTEGER,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT,
  FOREIGN KEY (party_id) REFERENCES parties(id),
  CHECK (status IN ('ACTIVE','CANCELLED')),
  CHECK ((receipt_amount_paisa > 0 AND payment_amount_paisa = 0) OR (payment_amount_paisa > 0 AND receipt_amount_paisa = 0))
);

INSERT INTO cash_vouchers_new (id, voucher_number, party_id, voucher_date, mode_of_transfer, description, receipt_amount_paisa, payment_amount_paisa, status, created_at, updated_at, deleted_at, deleted_by, delete_reason)
SELECT id, voucher_number, party_id, voucher_date, mode_of_transfer, description, receipt_amount_paisa, payment_amount_paisa, status, created_at, updated_at, deleted_at, deleted_by, delete_reason
FROM cash_vouchers;

DROP TABLE cash_vouchers;

ALTER TABLE cash_vouchers_new RENAME TO cash_vouchers;

-- migrations/sqlite/007_cash_voucher_transfer_details added bank_account_title/cheque_number/
-- cheque_date/online_from/online_to/reference_no after local-schema.sql's base definition of
-- this table was written - by migration 030's point in a real boot sequence (fresh or upgrade)
-- those columns already exist, so the rebuild must carry them over too.
CREATE TABLE cash_voucher_lines_new (
  id TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL,
  party_id TEXT NOT NULL,
  description TEXT NOT NULL,
  mode_of_transfer TEXT NOT NULL DEFAULT 'Cash',
  bank_account_title TEXT NOT NULL DEFAULT '',
  cheque_number TEXT NOT NULL DEFAULT '',
  cheque_date TEXT NOT NULL DEFAULT '',
  online_from TEXT NOT NULL DEFAULT '',
  online_to TEXT NOT NULL DEFAULT '',
  reference_no TEXT NOT NULL DEFAULT '',
  receipt_amount_paisa INTEGER,
  payment_amount_paisa INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (voucher_id) REFERENCES cash_vouchers(id) ON DELETE CASCADE,
  FOREIGN KEY (party_id) REFERENCES parties(id),
  CHECK ((receipt_amount_paisa > 0 AND payment_amount_paisa = 0) OR (payment_amount_paisa > 0 AND receipt_amount_paisa = 0))
);

INSERT INTO cash_voucher_lines_new (id, voucher_id, party_id, description, mode_of_transfer, bank_account_title, cheque_number, cheque_date, online_from, online_to, reference_no, receipt_amount_paisa, payment_amount_paisa, created_at)
SELECT id, voucher_id, party_id, description, mode_of_transfer, bank_account_title, cheque_number, cheque_date, online_from, online_to, reference_no, receipt_amount_paisa, payment_amount_paisa, created_at
FROM cash_voucher_lines;

DROP TABLE cash_voucher_lines;

ALTER TABLE cash_voucher_lines_new RENAME TO cash_voucher_lines;

ALTER TABLE purchase_vouchers DROP COLUMN total_amount;

ALTER TABLE purchase_voucher_line_items DROP COLUMN unit_price;
ALTER TABLE purchase_voucher_line_items DROP COLUMN total_price;

CREATE INDEX IF NOT EXISTS idx_party_price_range_discounts_party_id ON party_price_range_discounts(party_id, start_price_paisa, end_price_paisa);

-- DROP TABLE also drops every index that belonged to the old cash_vouchers/cash_voucher_lines,
-- so the ones that existed before this migration are recreated here against the renamed tables.
CREATE INDEX IF NOT EXISTS idx_cash_vouchers_party_id ON cash_vouchers(party_id);
CREATE INDEX IF NOT EXISTS idx_cash_vouchers_voucher_date ON cash_vouchers(voucher_date);
CREATE INDEX IF NOT EXISTS idx_cash_vouchers_voucher_number ON cash_vouchers(voucher_number);
CREATE INDEX IF NOT EXISTS idx_cash_vouchers_status ON cash_vouchers(status);
CREATE INDEX IF NOT EXISTS idx_cash_voucher_lines_voucher_id ON cash_voucher_lines(voucher_id);
