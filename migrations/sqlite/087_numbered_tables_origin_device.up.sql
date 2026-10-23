-- Every numbered table learns which computer created the row.
--
-- WHY THIS BLOCKS REPLICATION, and is therefore a prerequisite rather than a feature.
--
-- allocateNumberInRange refuses to issue a number when countOutsideRange finds any row in the
-- table whose number falls outside this computer's block:
--
--   const stray = countOutsideRange(db, site, range)
--   if (stray.count > 0) throw new NumberRangeError("OUT_OF_RANGE", ...)
--
-- Today that count is always zero, because a computer only ever holds its own documents. The
-- moment a numbered table replicates it is never zero: PC 1 holds PC 2's gatepasses, and PC 2's
-- numbers are in block 2 BY DESIGN. So every numbered document creation would fail on every
-- computer, immediately -- no gatepass, no bill, no party, no product. See docs/37 section 0.1.
--
-- The check is not wrong, it is just asking the wrong question. "Is there a number here outside
-- my block" has to become "is there a number here THAT I ISSUED outside my block", and that
-- needs to know who issued each row.
--
-- WHY A NEW COLUMN NAME AND NOT device_id. Four of the eighteen numbered tables already carry
-- device_id -- the four session tables, where it means the device that performed the session.
-- Those are left alone. The fourteen here get origin_device_id, which matches the vocabulary the
-- sync layer already uses (origin_device_id in the cloud sync_event_log, originDeviceId on an
-- envelope) and reads honestly on a table like parties, where "the device that created this
-- party" is a provenance fact and not a property of the party.
--
-- THE BACKFILL IS 'desktop-main' because that is this installation's device id, read from
-- device-identity.json rather than assumed. There is exactly one installation today. A computer
-- provisioned later from a snapshot will hold these rows stamped desktop-main, which is correct:
-- it did not issue them, so they must not constrain its own allocation.
--
-- NULL IS NOT MINE. After this migration no row on this computer is NULL, but a replicated row
-- arriving from a computer that predates the column could be. countOutsideRange matches on
-- equality, so NULL rows are excluded -- they cannot be attributed, so they must not block
-- anybody's allocation.
--
-- app_settings GAINS device.id so the data layer can answer "who am I" without reading the
-- filesystem. ensureOperationalContext keeps it current on every startup, and it is seeded here
-- so the value exists before the next start. app_settings is already on the replication
-- exclusion list (docs/37 section 0.2), which is exactly where a per-machine fact belongs.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE cash_vouchers ADD COLUMN origin_device_id TEXT;
ALTER TABLE sale_vouchers ADD COLUMN origin_device_id TEXT;
ALTER TABLE purchase_vouchers ADD COLUMN origin_device_id TEXT;
ALTER TABLE gatepasses ADD COLUMN origin_device_id TEXT;
ALTER TABLE machine_programs ADD COLUMN origin_device_id TEXT;
ALTER TABLE manual_production_entries ADD COLUMN origin_device_id TEXT;
ALTER TABLE parties ADD COLUMN origin_device_id TEXT;
ALTER TABLE article_sizes ADD COLUMN origin_device_id TEXT;
ALTER TABLE party_claims ADD COLUMN origin_device_id TEXT;
ALTER TABLE removal_requests ADD COLUMN origin_device_id TEXT;
ALTER TABLE stock_correction_requests ADD COLUMN origin_device_id TEXT;
ALTER TABLE machines ADD COLUMN origin_device_id TEXT;
ALTER TABLE inventory_items ADD COLUMN origin_device_id TEXT;
ALTER TABLE work_sections ADD COLUMN origin_device_id TEXT;

UPDATE cash_vouchers SET origin_device_id = 'desktop-main' WHERE origin_device_id IS NULL;
UPDATE sale_vouchers SET origin_device_id = 'desktop-main' WHERE origin_device_id IS NULL;
UPDATE purchase_vouchers SET origin_device_id = 'desktop-main' WHERE origin_device_id IS NULL;
UPDATE gatepasses SET origin_device_id = 'desktop-main' WHERE origin_device_id IS NULL;
UPDATE machine_programs SET origin_device_id = 'desktop-main' WHERE origin_device_id IS NULL;
UPDATE manual_production_entries SET origin_device_id = 'desktop-main' WHERE origin_device_id IS NULL;
UPDATE parties SET origin_device_id = 'desktop-main' WHERE origin_device_id IS NULL;
UPDATE article_sizes SET origin_device_id = 'desktop-main' WHERE origin_device_id IS NULL;
UPDATE party_claims SET origin_device_id = 'desktop-main' WHERE origin_device_id IS NULL;
UPDATE removal_requests SET origin_device_id = 'desktop-main' WHERE origin_device_id IS NULL;
UPDATE stock_correction_requests SET origin_device_id = 'desktop-main' WHERE origin_device_id IS NULL;
UPDATE machines SET origin_device_id = 'desktop-main' WHERE origin_device_id IS NULL;
UPDATE inventory_items SET origin_device_id = 'desktop-main' WHERE origin_device_id IS NULL;
UPDATE work_sections SET origin_device_id = 'desktop-main' WHERE origin_device_id IS NULL;

INSERT INTO app_settings (setting_key, setting_value, value_type, is_encrypted, updated_by, updated_at)
VALUES ('device.id', 'desktop-main', 'string', 0, 'migration-087', '2026-10-23T00:00:00.000Z')
ON CONFLICT(setting_key) DO NOTHING;
