-- Forgets how machine programs were closed and reconciled.
--
-- The programs stay COMPLETED and every stock movement stands: what is lost is the record of the
-- shortfall and of the claims made for it.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

DROP INDEX IF EXISTS idx_machine_program_reconciliation_lines_program;

DROP TABLE IF EXISTS machine_program_reconciliation_lines;

DROP TABLE IF EXISTS machine_program_closures;
