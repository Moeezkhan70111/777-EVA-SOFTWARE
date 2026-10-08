-- The columns added to machines, machine_programs and raw_material_qr_events are additive and
-- nullable or defaulted, so they are left in place. Dropping the new tables and indexes undoes
-- the feature. The first-shape programs closed by the up migration stay closed - re-opening
-- them would put back reservations nobody has looked at since.
DROP INDEX IF EXISTS idx_raw_material_qr_events_upper_line;
DROP INDEX IF EXISTS idx_machine_program_upper_lines_item;
DROP INDEX IF EXISTS idx_machine_program_upper_lines_source;
DROP TABLE IF EXISTS machine_program_upper_lines;
DROP INDEX IF EXISTS idx_machine_program_runs_program;
DROP TABLE IF EXISTS machine_program_runs;
DROP INDEX IF EXISTS idx_machine_programs_machine_date;
DROP TABLE IF EXISTS sole_types;
