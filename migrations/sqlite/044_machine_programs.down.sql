-- The column added to raw_material_qr_events is additive and nullable, and SQLite before
-- 3.35 cannot DROP COLUMN, so it is left in place. Dropping the new tables and indexes is
-- enough to undo the feature: with no machine_program_lines rows left, the stamp on an old
-- event no longer names anything and Reserved goes back to zero everywhere.
DROP INDEX IF EXISTS idx_raw_material_qr_events_program_line;
DROP INDEX IF EXISTS idx_machine_program_lines_item;
DROP INDEX IF EXISTS idx_machine_program_lines_program;
DROP TABLE IF EXISTS machine_program_lines;
DROP INDEX IF EXISTS idx_machine_programs_status;
DROP INDEX IF EXISTS idx_machine_programs_date;
DROP INDEX IF EXISTS idx_machine_programs_live;
DROP TABLE IF EXISTS machine_programs;
DROP INDEX IF EXISTS idx_machines_status;
DROP TABLE IF EXISTS machines;
