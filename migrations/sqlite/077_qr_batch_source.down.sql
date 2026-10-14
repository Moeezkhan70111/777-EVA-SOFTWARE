-- Takes the run source back out. Every run and every code stays registered -- only the record of
-- which writer made each run goes, and the Machine Program has nothing left to read it from.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

DROP INDEX IF EXISTS idx_qr_batches_source_variant;

ALTER TABLE qr_batches DROP COLUMN source;
