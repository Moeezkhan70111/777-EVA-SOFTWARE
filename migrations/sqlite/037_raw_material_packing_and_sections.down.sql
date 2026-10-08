-- SQLite before 3.35 cannot DROP COLUMN, and the columns added to inventory_items /
-- raw_material_qrs are additive and nullable, so they are left in place. Dropping the new
-- tables and indexes is enough to undo the feature.
DROP INDEX IF EXISTS idx_raw_material_qr_events_item;
DROP INDEX IF EXISTS idx_raw_material_qr_events_date;
DROP INDEX IF EXISTS idx_raw_material_qr_events_qr;
DROP TABLE IF EXISTS raw_material_qr_events;
DROP INDEX IF EXISTS idx_raw_material_qrs_current_status;
DROP TABLE IF EXISTS work_sections;
