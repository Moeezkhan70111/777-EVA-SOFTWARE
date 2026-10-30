-- Removes the arrival time from the raw-material packet identity tables.
--
-- Nothing decides anything from replicated_at. Dropping it loses only the record of which runs
-- and packets came from another computer, and when.
--
-- Nothing executes this file: the runner reads *.up.sql only. It exists so the forward migration
-- can be read against its inverse.
--
-- (No semicolons in comments.)

ALTER TABLE raw_material_qrs DROP COLUMN replicated_at;
ALTER TABLE raw_material_qr_batches DROP COLUMN replicated_at;
