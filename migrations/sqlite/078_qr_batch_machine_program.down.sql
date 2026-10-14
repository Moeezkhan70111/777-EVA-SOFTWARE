-- Takes the run's machine program back out. The programs it opened stay in machine_programs, and
-- every run and code stays registered -- only the link from a run to its program goes.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

DROP INDEX IF EXISTS idx_qr_batches_machine_program;

ALTER TABLE qr_batches DROP COLUMN machine_program_id;
