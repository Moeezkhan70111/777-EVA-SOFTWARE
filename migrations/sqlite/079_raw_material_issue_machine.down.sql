-- Takes the issue machine back out. Every packet, event and stock movement stays -- only the
-- record of which machine an upper was issued to goes.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

DROP INDEX IF EXISTS idx_raw_material_qr_events_machine;

ALTER TABLE raw_material_qr_events DROP COLUMN machine_id;
