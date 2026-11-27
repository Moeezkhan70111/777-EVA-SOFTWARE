-- A customer and its discount rules travel together (owner, 27 Nov 2026: "make discount policies sync to the cloud").
--
-- From this build the four rule tables are children of the PARTY record (masterRecords.ts) and their writes mark the
-- party for sending (masterCapture.ts), under the PARTIES lease (leaseChannels.ts). Rules saved before this build were
-- never marked, so this queues, ONCE, every customer that has any rule, on the computer that holds PARTIES and on no
-- other. There the next revision of each such customer carries its rules up. Anywhere else the rules belong to the
-- PARTIES computer to send.
--
-- No table changes. Deleted rules (deleted_at set) are rows too and travel as they are, so a receiver reads the same
-- history. The capture triggers are dropped while migrations run, so the marks are written here, as 117 does.

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
