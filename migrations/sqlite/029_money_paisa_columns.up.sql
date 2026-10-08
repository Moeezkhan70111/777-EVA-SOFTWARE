-- Additive first step of the REAL rupees -> INTEGER paisa migration (CLAUDE.md R15).
-- Adds a parallel *_paisa INTEGER column next to every monetary REAL column and backfills
-- it with an exact conversion. The REAL column is untouched and stays authoritative for
-- every existing reader until a later migration switches them over - this one only adds data.
--
-- Conversion: CAST(ROUND(value * 100) AS INTEGER), NULL stays NULL. Verified against the
-- live database before this migration was written: every existing value is a whole rupee
-- (no fractional rupees, nothing needing more than 2 decimal places), so the conversion is
-- exact for all data that exists today - No semicolons anywhere in this comment block, not
-- even as English punctuation - the migration runner splits statements on them.

ALTER TABLE article_sizes ADD COLUMN cost_price_paisa INTEGER;
ALTER TABLE article_sizes ADD COLUMN selling_price_paisa INTEGER;
UPDATE article_sizes SET cost_price_paisa = CAST(ROUND(cost_price * 100) AS INTEGER) WHERE cost_price IS NOT NULL;
UPDATE article_sizes SET selling_price_paisa = CAST(ROUND(selling_price * 100) AS INTEGER) WHERE selling_price IS NOT NULL;

ALTER TABLE product_variants ADD COLUMN cost_price_paisa INTEGER;
ALTER TABLE product_variants ADD COLUMN selling_price_paisa INTEGER;
UPDATE product_variants SET cost_price_paisa = CAST(ROUND(cost_price * 100) AS INTEGER) WHERE cost_price IS NOT NULL;
UPDATE product_variants SET selling_price_paisa = CAST(ROUND(selling_price * 100) AS INTEGER) WHERE selling_price IS NOT NULL;

ALTER TABLE parties ADD COLUMN balance_limit_paisa INTEGER;
UPDATE parties SET balance_limit_paisa = CAST(ROUND(balance_limit * 100) AS INTEGER) WHERE balance_limit IS NOT NULL;

ALTER TABLE inventory_items ADD COLUMN cost_price_paisa INTEGER;
UPDATE inventory_items SET cost_price_paisa = CAST(ROUND(cost_price * 100) AS INTEGER) WHERE cost_price IS NOT NULL;

ALTER TABLE party_product_group_discounts ADD COLUMN discount_per_pair_paisa INTEGER;
UPDATE party_product_group_discounts SET discount_per_pair_paisa = CAST(ROUND(discount_per_pair * 100) AS INTEGER) WHERE discount_per_pair IS NOT NULL;

ALTER TABLE party_article_series_discounts ADD COLUMN discount_per_pair_paisa INTEGER;
UPDATE party_article_series_discounts SET discount_per_pair_paisa = CAST(ROUND(discount_per_pair * 100) AS INTEGER) WHERE discount_per_pair IS NOT NULL;

ALTER TABLE party_article_discounts ADD COLUMN discount_per_pair_paisa INTEGER;
UPDATE party_article_discounts SET discount_per_pair_paisa = CAST(ROUND(discount_per_pair * 100) AS INTEGER) WHERE discount_per_pair IS NOT NULL;

ALTER TABLE party_price_range_discounts ADD COLUMN start_price_paisa INTEGER;
ALTER TABLE party_price_range_discounts ADD COLUMN end_price_paisa INTEGER;
ALTER TABLE party_price_range_discounts ADD COLUMN discount_per_pair_paisa INTEGER;
UPDATE party_price_range_discounts SET start_price_paisa = CAST(ROUND(start_price * 100) AS INTEGER) WHERE start_price IS NOT NULL;
UPDATE party_price_range_discounts SET end_price_paisa = CAST(ROUND(end_price * 100) AS INTEGER) WHERE end_price IS NOT NULL;
UPDATE party_price_range_discounts SET discount_per_pair_paisa = CAST(ROUND(discount_per_pair * 100) AS INTEGER) WHERE discount_per_pair IS NOT NULL;

ALTER TABLE sale_vouchers ADD COLUMN total_amount_paisa INTEGER;
UPDATE sale_vouchers SET total_amount_paisa = CAST(ROUND(total_amount * 100) AS INTEGER) WHERE total_amount IS NOT NULL;

ALTER TABLE sale_voucher_line_items ADD COLUMN unit_price_paisa INTEGER;
ALTER TABLE sale_voucher_line_items ADD COLUMN discount_paisa INTEGER;
ALTER TABLE sale_voucher_line_items ADD COLUMN discount_per_pair_paisa INTEGER;
ALTER TABLE sale_voucher_line_items ADD COLUMN total_price_paisa INTEGER;
UPDATE sale_voucher_line_items SET unit_price_paisa = CAST(ROUND(unit_price * 100) AS INTEGER) WHERE unit_price IS NOT NULL;
UPDATE sale_voucher_line_items SET discount_paisa = CAST(ROUND(discount * 100) AS INTEGER) WHERE discount IS NOT NULL;
UPDATE sale_voucher_line_items SET discount_per_pair_paisa = CAST(ROUND(discount_per_pair * 100) AS INTEGER) WHERE discount_per_pair IS NOT NULL;
UPDATE sale_voucher_line_items SET total_price_paisa = CAST(ROUND(total_price * 100) AS INTEGER) WHERE total_price IS NOT NULL;

ALTER TABLE cash_vouchers ADD COLUMN receipt_amount_paisa INTEGER;
ALTER TABLE cash_vouchers ADD COLUMN payment_amount_paisa INTEGER;
UPDATE cash_vouchers SET receipt_amount_paisa = CAST(ROUND(receipt_amount * 100) AS INTEGER) WHERE receipt_amount IS NOT NULL;
UPDATE cash_vouchers SET payment_amount_paisa = CAST(ROUND(payment_amount * 100) AS INTEGER) WHERE payment_amount IS NOT NULL;

ALTER TABLE cash_voucher_lines ADD COLUMN receipt_amount_paisa INTEGER;
ALTER TABLE cash_voucher_lines ADD COLUMN payment_amount_paisa INTEGER;
UPDATE cash_voucher_lines SET receipt_amount_paisa = CAST(ROUND(receipt_amount * 100) AS INTEGER) WHERE receipt_amount IS NOT NULL;
UPDATE cash_voucher_lines SET payment_amount_paisa = CAST(ROUND(payment_amount * 100) AS INTEGER) WHERE payment_amount IS NOT NULL;

ALTER TABLE purchase_vouchers ADD COLUMN total_amount_paisa INTEGER;
UPDATE purchase_vouchers SET total_amount_paisa = CAST(ROUND(total_amount * 100) AS INTEGER) WHERE total_amount IS NOT NULL;

ALTER TABLE purchase_voucher_line_items ADD COLUMN unit_price_paisa INTEGER;
ALTER TABLE purchase_voucher_line_items ADD COLUMN total_price_paisa INTEGER;
UPDATE purchase_voucher_line_items SET unit_price_paisa = CAST(ROUND(unit_price * 100) AS INTEGER) WHERE unit_price IS NOT NULL;
UPDATE purchase_voucher_line_items SET total_price_paisa = CAST(ROUND(total_price * 100) AS INTEGER) WHERE total_price IS NOT NULL;

-- report_daily_summary has no writer or reader anywhere in the codebase today (verified) - the
-- columns are added for completeness/consistency only, nothing to backfill differently.
ALTER TABLE report_daily_summary ADD COLUMN inventory_value_cost_paisa INTEGER;
ALTER TABLE report_daily_summary ADD COLUMN inventory_value_sales_paisa INTEGER;
UPDATE report_daily_summary SET inventory_value_cost_paisa = CAST(ROUND(inventory_value_cost * 100) AS INTEGER) WHERE inventory_value_cost IS NOT NULL;
UPDATE report_daily_summary SET inventory_value_sales_paisa = CAST(ROUND(inventory_value_sales * 100) AS INTEGER) WHERE inventory_value_sales IS NOT NULL;
