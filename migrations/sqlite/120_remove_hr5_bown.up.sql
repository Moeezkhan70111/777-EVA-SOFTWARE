-- BOWN on HR-5 was never a colour (owner, 27 Nov 2026: "BOWN IS NOT A COLOR, REMOVE IT FROM CLOUD SO ON EVERY PC IT
-- IS REMOVED LIKE IT NEVER EXISTED"). The production cloud held no stock, adjustment, gatepass, voucher or order for it.
--
-- Every computer deletes the variant row outright, and ONLY if nothing here names it: no production, carton or stock
-- event, adjustment line, gatepass line, sale line, sale return, manual production, order line, carton identity or
-- printed label. Should anything name it the row stays and nothing changes. Stock projections for it are derived rows
-- and go with it.
--
-- The computer holding MASTER_DATA (PC1) then marks the HR-5 article size for sending. Its next revision carries no
-- BOWN, and every receiver drops the row when that revision arrives, as it drops any child a revision no longer holds.
-- The capture triggers are dropped while migrations run, so the mark is written here, as 117 and 119 do.

CREATE TEMP TABLE bown_doomed AS
SELECT v.id, v.article_size_id
FROM product_variants v
WHERE upper(trim(v.article)) = 'HR-5'
  AND replace(replace(upper(trim(v.color)), ' ', ''), '-', '') = 'BOWN'
  AND NOT EXISTS (SELECT 1 FROM production_events x WHERE x.product_variant_id = v.id)
  AND NOT EXISTS (SELECT 1 FROM sale_voucher_line_items x WHERE x.product_variant_id = v.id)
  AND NOT EXISTS (SELECT 1 FROM sale_returns x WHERE x.product_variant_id = v.id)
  AND NOT EXISTS (SELECT 1 FROM gatepass_lines x WHERE x.product_variant_id = v.id)
  AND NOT EXISTS (SELECT 1 FROM qr_master x WHERE x.product_variant_id = v.id)
  AND NOT EXISTS (SELECT 1 FROM carton_stock_events x WHERE x.product_variant_id = v.id)
  AND NOT EXISTS (SELECT 1 FROM manual_production_entries x WHERE x.product_variant_id = v.id)
  AND NOT EXISTS (SELECT 1 FROM carton_stock_adjustment_lines x WHERE x.product_variant_id = v.id)
  AND NOT EXISTS (SELECT 1 FROM customer_order_lines x WHERE x.product_variant_id = v.id)
  AND NOT EXISTS (SELECT 1 FROM qr_codes x WHERE x.product_variant_id = v.id OR (upper(trim(x.article)) = 'HR-5' AND replace(upper(trim(x.color)), ' ', '') = 'BOWN'))
  AND NOT EXISTS (SELECT 1 FROM qr_batches x WHERE upper(trim(x.article)) = 'HR-5' AND replace(upper(trim(x.color)), ' ', '') = 'BOWN')
  AND NOT EXISTS (SELECT 1 FROM stock_projection_by_variant x WHERE x.product_variant_id = v.id AND (x.quantity_on_hand <> 0 OR x.quantity_reserved <> 0 OR x.quantity_damaged <> 0))
  AND NOT EXISTS (SELECT 1 FROM stock_projection_by_location x WHERE x.product_variant_id = v.id AND x.quantity_on_hand <> 0);

DELETE FROM stock_projection_by_variant WHERE product_variant_id IN (SELECT id FROM bown_doomed);

DELETE FROM stock_projection_by_location WHERE product_variant_id IN (SELECT id FROM bown_doomed);

DELETE FROM product_variants WHERE id IN (SELECT id FROM bown_doomed);

INSERT INTO sync_dirty_records (aggregate_type, record_id, lease_epoch, marked_at)
SELECT DISTINCT 'ARTICLE_SIZE', d.article_size_id, l.epoch, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM bown_doomed d
JOIN article_sizes a ON a.id = d.article_size_id
JOIN sync_domain_leases l ON l.domain = 'MASTER_DATA' AND l.epoch > 0
 AND l.holder_device_id = (SELECT setting_value FROM app_settings WHERE setting_key = 'device.id')
WHERE 1
ON CONFLICT (aggregate_type, record_id) DO UPDATE SET lease_epoch = excluded.lease_epoch, marked_at = excluded.marked_at;

DROP TABLE bown_doomed;
