-- EVR LADIES AND EVR KIDS GET EACH CUSTOMER'S EVR GENTS DISCOUNT (owner, 27 Nov 2026: "the discount policy in cloud is
-- for evr gents. evr ladies and evr kids have same less. do it automatically").
--
-- On the production cloud 88 customers had an EVR GENTS discount per pair. Two of them also had EVR LADIES and EVR KIDS
-- rules, each equal to their GENTS one. This gives every customer with a live EVR GENTS rule the same discount per
-- pair on EVR LADIES and on EVR KIDS, ONCE, on the computer that holds PARTIES (PC1), where discount rules are written.
--
--   A customer who already has a live LADIES or KIDS rule keeps it as it is. It is their own, whatever its figure.
--   A customer whose LADIES or KIDS rule was deleted gets that row back with the GENTS figure (one row per customer and
--   group, as Discount Policy keeps it).
--   Anywhere but the PARTIES computer nothing is written: the rules arrive with each customer from PC1.
--
-- Each changed customer is marked for sending, so the new rules travel inside its PARTY record (local 119). The
-- capture triggers are dropped while migrations run, so the marks are written here, as 119 does.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TEMP TABLE evr_rule_copy AS
SELECT g.party_id, target.id AS product_group_id, g.discount_per_pair_paisa AS paisa
FROM party_product_group_discounts g
JOIN product_groups gents ON gents.id = g.product_group_id AND UPPER(TRIM(gents.group_name)) = 'EVR GENTS'
JOIN product_groups target ON UPPER(TRIM(target.group_name)) IN ('EVR LADIES', 'EVR KIDS') AND target.deleted_at IS NULL
WHERE g.deleted_at IS NULL
  AND g.discount_per_pair_paisa IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM sync_domain_leases l
     WHERE l.domain = 'PARTIES' AND l.epoch > 0
       AND l.holder_device_id = (SELECT setting_value FROM app_settings WHERE setting_key = 'device.id')
  )
  AND NOT EXISTS (
    SELECT 1 FROM party_product_group_discounts own
     WHERE own.party_id = g.party_id AND own.product_group_id = target.id AND own.deleted_at IS NULL
  );

UPDATE party_product_group_discounts
   SET discount_per_pair_paisa = (
         SELECT c.paisa FROM evr_rule_copy c
          WHERE c.party_id = party_product_group_discounts.party_id AND c.product_group_id = party_product_group_discounts.product_group_id
       ),
       deleted_at = NULL,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE EXISTS (
         SELECT 1 FROM evr_rule_copy c
          WHERE c.party_id = party_product_group_discounts.party_id AND c.product_group_id = party_product_group_discounts.product_group_id
       );

INSERT INTO party_product_group_discounts (id, party_id, product_group_id, discount_per_pair_paisa, created_at, updated_at, deleted_at)
SELECT lower(substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-a' || substr(h, 18, 3) || '-' || substr(h, 21, 12)),
       c.party_id, c.product_group_id, c.paisa,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
FROM (SELECT hex(randomblob(16)) AS h, party_id, product_group_id, paisa FROM evr_rule_copy) c
WHERE NOT EXISTS (
  SELECT 1 FROM party_product_group_discounts x WHERE x.party_id = c.party_id AND x.product_group_id = c.product_group_id
);

INSERT INTO sync_dirty_records (aggregate_type, record_id, lease_epoch, marked_at)
SELECT DISTINCT 'PARTY', c.party_id, l.epoch, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM evr_rule_copy c
JOIN sync_domain_leases l ON l.domain = 'PARTIES' AND l.epoch > 0
 AND l.holder_device_id = (SELECT setting_value FROM app_settings WHERE setting_key = 'device.id')
WHERE 1
ON CONFLICT (aggregate_type, record_id) DO UPDATE SET lease_epoch = excluded.lease_epoch, marked_at = excluded.marked_at;

DROP TABLE evr_rule_copy;
