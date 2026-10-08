DROP TABLE IF EXISTS purchase_voucher_line_items;
DROP TABLE IF EXISTS purchase_vouchers;
ALTER TABLE inventory_items DROP COLUMN cost_price;
-- Note: parties table rebuild to remove CONTRACTOR is intentionally not reversed
-- (rebuilding again risks data loss); CONTRACTOR rows would need manual handling.
