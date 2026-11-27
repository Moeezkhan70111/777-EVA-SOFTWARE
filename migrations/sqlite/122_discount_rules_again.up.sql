-- DISCOUNT RULES SENT AGAIN, ONCE (owner, 27 Nov 2026: "PC3 SHOWS NOTHING IN DISCOUNT POLICY").
--
-- 119 sent every customer with rules from PC1 at 13:25 UTC on 27 Nov. A computer still on a build before 119 read
-- those revisions with a record spec that had no rule children, so it kept the customer and dropped the rules, and it
-- never reads a revision twice. PC3 was one. This queues every such customer once more on the computer that holds
-- PARTIES, and on no other. Each goes as a new revision, and a computer on 0.6.10 or later writes its rules.
--
-- No table changes. A receiver that already holds the rules writes the same rows again. The capture triggers are
-- dropped while migrations run, so the marks are written here, as 119 does.

INSERT INTO sync_dirty_records (aggregate_type, record_id, lease_epoch, marked_at)
SELECT 'PARTY', ruled.party_id, l.epoch, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (
  SELECT party_id FROM party_product_group_discounts
  UNION SELECT party_id FROM party_article_series_discounts
  UNION SELECT party_id FROM party_article_discounts
  UNION SELECT party_id FROM party_price_range_discounts
) ruled
JOIN parties p ON p.id = ruled.party_id
JOIN sync_domain_leases l ON l.domain = 'PARTIES' AND l.epoch > 0
 AND l.holder_device_id = (SELECT setting_value FROM app_settings WHERE setting_key = 'device.id')
WHERE 1
ON CONFLICT (aggregate_type, record_id) DO UPDATE SET lease_epoch = excluded.lease_epoch, marked_at = excluded.marked_at;
