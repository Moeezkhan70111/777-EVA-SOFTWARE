-- Takes B cartons back out. The B labels already printed stay registered QR codes, and the
-- originals they replaced stay void -- only the record of the conversion and the grade go.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

DROP INDEX IF EXISTS idx_machine_program_b_conversions_program;

DROP TABLE IF EXISTS machine_program_b_conversions;

ALTER TABLE qr_batches DROP COLUMN grade;
