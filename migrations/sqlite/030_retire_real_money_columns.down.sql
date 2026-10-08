-- Manual rollback only - like every other .down.sql in this project, this is never run
-- automatically (runMigrations only applies .up.sql files) - No semicolons in comments, the
-- migration runner splits statements on them
--
-- Re-adds each retired REAL column and backfills it exactly from its still-present *_paisa
-- sibling - original NOT NULL/CHECK constraints are not reconstructed here (SQLite's ADD
-- COLUMN cannot add a NOT NULL column without a DEFAULT that satisfies existing rows); this is
-- a data-recovery safety net, not a byte-for-byte schema restoration

DROP INDEX IF EXISTS idx_party_price_range_discounts_party_id;

ALTER TABLE article_sizes ADD COLUMN cost_price REAL;
UPDATE article_sizes SET cost_price = cost_price_paisa / 100.0 WHERE cost_price_paisa IS NOT NULL;
ALTER TABLE article_sizes ADD COLUMN selling_price REAL;
UPDATE article_sizes SET selling_price = selling_price_paisa / 100.0 WHERE selling_price_paisa IS NOT NULL;

ALTER TABLE product_variants ADD COLUMN cost_price REAL;
UPDATE product_variants SET cost_price = cost_price_paisa / 100.0 WHERE cost_price_paisa IS NOT NULL;
ALTER TABLE product_variants ADD COLUMN selling_price REAL;
UPDATE product_variants SET selling_price = selling_price_paisa / 100.0 WHERE selling_price_paisa IS NOT NULL;

ALTER TABLE parties ADD COLUMN balance_limit REAL;
UPDATE parties SET balance_limit = balance_limit_paisa / 100.0 WHERE balance_limit_paisa IS NOT NULL;

ALTER TABLE inventory_items ADD COLUMN cost_price REAL;
UPDATE inventory_items SET cost_price = cost_price_paisa / 100.0 WHERE cost_price_paisa IS NOT NULL;

ALTER TABLE party_product_group_discounts ADD COLUMN discount_per_pair REAL;
UPDATE party_product_group_discounts SET discount_per_pair = discount_per_pair_paisa / 100.0 WHERE discount_per_pair_paisa IS NOT NULL;

ALTER TABLE party_article_series_discounts ADD COLUMN discount_per_pair REAL;
UPDATE party_article_series_discounts SET discount_per_pair = discount_per_pair_paisa / 100.0 WHERE discount_per_pair_paisa IS NOT NULL;

ALTER TABLE party_article_discounts ADD COLUMN discount_per_pair REAL;
UPDATE party_article_discounts SET discount_per_pair = discount_per_pair_paisa / 100.0 WHERE discount_per_pair_paisa IS NOT NULL;

ALTER TABLE party_price_range_discounts ADD COLUMN start_price REAL;
UPDATE party_price_range_discounts SET start_price = start_price_paisa / 100.0 WHERE start_price_paisa IS NOT NULL;
ALTER TABLE party_price_range_discounts ADD COLUMN end_price REAL;
UPDATE party_price_range_discounts SET end_price = end_price_paisa / 100.0 WHERE end_price_paisa IS NOT NULL;
ALTER TABLE party_price_range_discounts ADD COLUMN discount_per_pair REAL;
UPDATE party_price_range_discounts SET discount_per_pair = discount_per_pair_paisa / 100.0 WHERE discount_per_pair_paisa IS NOT NULL;

ALTER TABLE sale_vouchers ADD COLUMN total_amount REAL;
UPDATE sale_vouchers SET total_amount = total_amount_paisa / 100.0 WHERE total_amount_paisa IS NOT NULL;

ALTER TABLE sale_voucher_line_items ADD COLUMN unit_price REAL;
UPDATE sale_voucher_line_items SET unit_price = unit_price_paisa / 100.0 WHERE unit_price_paisa IS NOT NULL;
ALTER TABLE sale_voucher_line_items ADD COLUMN discount REAL;
UPDATE sale_voucher_line_items SET discount = discount_paisa / 100.0 WHERE discount_paisa IS NOT NULL;
ALTER TABLE sale_voucher_line_items ADD COLUMN discount_per_pair REAL;
UPDATE sale_voucher_line_items SET discount_per_pair = discount_per_pair_paisa / 100.0 WHERE discount_per_pair_paisa IS NOT NULL;
ALTER TABLE sale_voucher_line_items ADD COLUMN total_price REAL;
UPDATE sale_voucher_line_items SET total_price = total_price_paisa / 100.0 WHERE total_price_paisa IS NOT NULL;

ALTER TABLE cash_vouchers ADD COLUMN receipt_amount REAL;
UPDATE cash_vouchers SET receipt_amount = receipt_amount_paisa / 100.0 WHERE receipt_amount_paisa IS NOT NULL;
ALTER TABLE cash_vouchers ADD COLUMN payment_amount REAL;
UPDATE cash_vouchers SET payment_amount = payment_amount_paisa / 100.0 WHERE payment_amount_paisa IS NOT NULL;

ALTER TABLE cash_voucher_lines ADD COLUMN receipt_amount REAL;
UPDATE cash_voucher_lines SET receipt_amount = receipt_amount_paisa / 100.0 WHERE receipt_amount_paisa IS NOT NULL;
ALTER TABLE cash_voucher_lines ADD COLUMN payment_amount REAL;
UPDATE cash_voucher_lines SET payment_amount = payment_amount_paisa / 100.0 WHERE payment_amount_paisa IS NOT NULL;

ALTER TABLE purchase_vouchers ADD COLUMN total_amount REAL;
UPDATE purchase_vouchers SET total_amount = total_amount_paisa / 100.0 WHERE total_amount_paisa IS NOT NULL;

ALTER TABLE purchase_voucher_line_items ADD COLUMN unit_price REAL;
UPDATE purchase_voucher_line_items SET unit_price = unit_price_paisa / 100.0 WHERE unit_price_paisa IS NOT NULL;
ALTER TABLE purchase_voucher_line_items ADD COLUMN total_price REAL;
UPDATE purchase_voucher_line_items SET total_price = total_price_paisa / 100.0 WHERE total_price_paisa IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_party_price_range_discounts_party_id ON party_price_range_discounts(party_id, start_price, end_price);
