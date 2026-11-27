-- BHAG WAS A TYPO OF BAG (owner, 27 Nov 2026: "i dont want BHAG. it was a typo").
--
-- Two units were made for a bag: BHAG on 23 Oct and BAG on 3 Nov. Both count whole bags (family COUNT, no decimals)
-- and neither has a conversion. In the production cloud BHAG was still the unit of 8 active materials (one Dana and
-- seven Thelli) and 16 inactive Dana, and of 773 recorded movements.
--
-- On EVERY computer, its own copy: everything that names BHAG names BAG instead, and NO FIGURE IS CONVERTED (28 BHAG is
-- 28 BAG), exactly as Correct unit does for one material (correctInventoryItemUnit). The material, its balance, its
-- movements, its labels, its programs and any unit ladder or conversion. Then BHAG is switched off, so it is offered
-- nowhere. It is not deleted: the movements already in the cloud still name it.
--
-- Kept as written: the words of old documents and notes ("Manual move in, 12 BHAG"), which are what was typed then.
--
-- Every changed material gets a CORRECT_UNIT line in its own history, with the reason.
--
-- The computer holding RAW_MATERIAL_STORE (PC2) marks the changed materials, the unit and any changed ladder preset for
-- sending, so the cloud and any new computer read BAG too. The capture triggers are dropped while migrations run, so
-- the marks are written here, as 117 and 119 do.
--
-- Nothing happens on a computer that does not have both units.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TEMP TABLE bhag_fold AS
SELECT (SELECT id FROM inventory_units WHERE code = 'BHAG') AS bhag, (SELECT id FROM inventory_units WHERE code = 'BAG') AS bag
WHERE EXISTS (SELECT 1 FROM inventory_units WHERE code = 'BHAG') AND EXISTS (SELECT 1 FROM inventory_units WHERE code = 'BAG');

CREATE TEMP TABLE bhag_items AS
SELECT i.id FROM inventory_items i, bhag_fold f
WHERE i.default_unit_id = f.bhag OR i.packing_unit_id = f.bhag
   OR EXISTS (SELECT 1 FROM inventory_item_unit_steps s WHERE s.item_id = i.id AND (s.from_unit_id = f.bhag OR s.to_unit_id = f.bhag));

CREATE TEMP TABLE bhag_presets AS
SELECT DISTINCT s.preset_id AS id FROM unit_ladder_preset_steps s, bhag_fold f WHERE s.from_unit_id = f.bhag OR s.to_unit_id = f.bhag;

INSERT INTO inventory_item_audit (id, item_id, entity_type, entity_id, action, old_value_json, new_value_json, changed_by, created_at)
SELECT lower(hex(randomblob(16))), b.id, 'ITEM', b.id, 'CORRECT_UNIT',
       json_object('unitCode', 'BHAG'),
       json_object('unitCode', 'BAG', 'reason', 'BHAG was a typo of BAG (owner, 27 Nov 2026)', 'quantitiesUnchanged', 1),
       'local 123', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM bhag_items b;

UPDATE inventory_items SET default_unit_id = (SELECT bag FROM bhag_fold) WHERE default_unit_id = (SELECT bhag FROM bhag_fold);

UPDATE inventory_items SET packing_unit_id = (SELECT bag FROM bhag_fold) WHERE packing_unit_id = (SELECT bhag FROM bhag_fold);

UPDATE inventory_items SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id IN (SELECT id FROM bhag_items);

UPDATE OR IGNORE inventory_item_unit_steps SET from_unit_id = (SELECT bag FROM bhag_fold) WHERE from_unit_id = (SELECT bhag FROM bhag_fold);

UPDATE OR IGNORE inventory_item_unit_steps SET to_unit_id = (SELECT bag FROM bhag_fold) WHERE to_unit_id = (SELECT bhag FROM bhag_fold);

DELETE FROM inventory_item_unit_steps WHERE from_unit_id = (SELECT bhag FROM bhag_fold) OR to_unit_id = (SELECT bhag FROM bhag_fold);

UPDATE OR IGNORE unit_ladder_preset_steps SET from_unit_id = (SELECT bag FROM bhag_fold) WHERE from_unit_id = (SELECT bhag FROM bhag_fold);

UPDATE OR IGNORE unit_ladder_preset_steps SET to_unit_id = (SELECT bag FROM bhag_fold) WHERE to_unit_id = (SELECT bhag FROM bhag_fold);

DELETE FROM unit_ladder_preset_steps WHERE from_unit_id = (SELECT bhag FROM bhag_fold) OR to_unit_id = (SELECT bhag FROM bhag_fold);

UPDATE OR IGNORE inventory_unit_conversions SET from_unit_id = (SELECT bag FROM bhag_fold) WHERE from_unit_id = (SELECT bhag FROM bhag_fold);

UPDATE OR IGNORE inventory_unit_conversions SET to_unit_id = (SELECT bag FROM bhag_fold) WHERE to_unit_id = (SELECT bhag FROM bhag_fold);

DELETE FROM inventory_unit_conversions WHERE from_unit_id = (SELECT bhag FROM bhag_fold) OR to_unit_id = (SELECT bhag FROM bhag_fold);

UPDATE inventory_stock_balances SET unit_id = (SELECT bag FROM bhag_fold) WHERE unit_id = (SELECT bhag FROM bhag_fold);

UPDATE inventory_stock_events SET unit_id = (SELECT bag FROM bhag_fold) WHERE unit_id = (SELECT bhag FROM bhag_fold);

UPDATE stock_correction_requests SET unit_id = (SELECT bag FROM bhag_fold) WHERE unit_id = (SELECT bhag FROM bhag_fold);

UPDATE raw_material_qrs SET packing_unit_id = (SELECT bag FROM bhag_fold) WHERE packing_unit_id = (SELECT bhag FROM bhag_fold);

UPDATE raw_material_qr_events SET unit_id = (SELECT bag FROM bhag_fold) WHERE unit_id = (SELECT bhag FROM bhag_fold);

UPDATE machine_program_lines SET packing_unit_id = (SELECT bag FROM bhag_fold) WHERE packing_unit_id = (SELECT bhag FROM bhag_fold);

UPDATE machine_program_upper_lines SET unit_id = (SELECT bag FROM bhag_fold) WHERE unit_id = (SELECT bhag FROM bhag_fold);

UPDATE machine_program_runs SET unit_id = (SELECT bag FROM bhag_fold) WHERE unit_id = (SELECT bhag FROM bhag_fold);

UPDATE inventory_units SET is_active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = (SELECT bhag FROM bhag_fold);

INSERT INTO sync_dirty_records (aggregate_type, record_id, lease_epoch, marked_at)
SELECT 'INVENTORY_ITEM', b.id, l.epoch, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM bhag_items b
JOIN sync_domain_leases l ON l.domain = 'RAW_MATERIAL_STORE' AND l.epoch > 0
 AND l.holder_device_id = (SELECT setting_value FROM app_settings WHERE setting_key = 'device.id')
WHERE 1
ON CONFLICT (aggregate_type, record_id) DO UPDATE SET lease_epoch = excluded.lease_epoch, marked_at = excluded.marked_at;

INSERT INTO sync_dirty_records (aggregate_type, record_id, lease_epoch, marked_at)
SELECT 'INVENTORY_UNIT', f.bhag, l.epoch, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM bhag_fold f
JOIN sync_domain_leases l ON l.domain = 'RAW_MATERIAL_STORE' AND l.epoch > 0
 AND l.holder_device_id = (SELECT setting_value FROM app_settings WHERE setting_key = 'device.id')
WHERE 1
ON CONFLICT (aggregate_type, record_id) DO UPDATE SET lease_epoch = excluded.lease_epoch, marked_at = excluded.marked_at;

INSERT INTO sync_dirty_records (aggregate_type, record_id, lease_epoch, marked_at)
SELECT 'UNIT_LADDER_PRESET', p.id, l.epoch, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM bhag_presets p
JOIN sync_domain_leases l ON l.domain = 'RAW_MATERIAL_STORE' AND l.epoch > 0
 AND l.holder_device_id = (SELECT setting_value FROM app_settings WHERE setting_key = 'device.id')
WHERE 1
ON CONFLICT (aggregate_type, record_id) DO UPDATE SET lease_epoch = excluded.lease_epoch, marked_at = excluded.marked_at;

DROP TABLE bhag_presets;

DROP TABLE bhag_items;

DROP TABLE bhag_fold;
