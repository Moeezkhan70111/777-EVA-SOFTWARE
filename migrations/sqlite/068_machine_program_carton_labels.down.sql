-- Forgets which issued packets have had their carton labels printed.
--
-- The carton QR codes themselves stay registered: they are ordinary rows in qr_batches and
-- qr_codes. What is lost is the link back to the uppers they were printed for, so Machine Move
-- Out would offer those cartons again.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

DROP INDEX IF EXISTS idx_machine_program_carton_labels_program;

DROP TABLE IF EXISTS machine_program_carton_labels;
