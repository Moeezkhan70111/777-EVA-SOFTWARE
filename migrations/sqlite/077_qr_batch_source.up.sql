-- WHERE A CARTON QR RUN CAME FROM -- the Machine Program is now read from the QR Generator.
--
--   QR Generator   SK6 / 7/10 / BLACKGREY  x 10   ->  source QR_GENERATOR  ->  Machine Program: 10 cartons, 5 dozen
--
-- qr_batches has five writers: the QR Generator page, the B Carton Labels page, the retired
-- machine-program workflow (Store Out carton labels and B conversions) and Live Production adopting
-- a code printed outside the system. Only the first is the Machine Program, and nothing on a row
-- said which writer made it -- an adopted code carries the station name in requested_by, which is
-- free text. source says it, once, on the row, so the program is a plain filter and not a guess.
--
-- Backfill, most specific first. A row the backfill cannot place stays NULL and is counted nowhere.
--   MACHINE_PROGRAM  linked from machine_program_carton_labels (068), machine_program_fix_carton_labels
--                    (071) or machine_program_b_conversions (074), or a B run whose requested_by is a
--                    program code (MP-000012) -- how every machine-program B run has been written
--   SCAN_ADOPTED     a one-code ordinary run whose code was produced at the very instant the run was
--                    written -- adoption writes both in one transaction with one timestamp, while a
--                    generated run is always printed and stuck on a carton before it is scanned
--   B_CARTON         any other B run
--   QR_GENERATOR     every other ordinary run
--
-- No row in qr_batches or qr_codes is created, deleted or re-sequenced.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE qr_batches ADD COLUMN source TEXT
  CHECK (source IS NULL OR source IN ('QR_GENERATOR','B_CARTON','MACHINE_PROGRAM','SCAN_ADOPTED'));

UPDATE qr_batches SET source = 'MACHINE_PROGRAM'
WHERE source IS NULL AND (
  id IN (SELECT qr_batch_id FROM machine_program_carton_labels)
  OR id IN (SELECT qr_batch_id FROM machine_program_fix_carton_labels)
  OR id IN (SELECT b_qr_batch_id FROM machine_program_b_conversions)
  OR (grade = 'B' AND requested_by IN (
        SELECT 'MP-' || substr('000000' || program_number, -6, 6) FROM machine_programs
      ))
);

UPDATE qr_batches SET source = 'SCAN_ADOPTED'
WHERE source IS NULL AND grade IS NULL AND quantity = 1
  AND EXISTS (
    SELECT 1 FROM qr_codes c JOIN qr_master qm ON qm.qr_id = c.id
    WHERE c.batch_id = qr_batches.id AND qm.created_at = qr_batches.created_at
  );

UPDATE qr_batches SET source = 'B_CARTON' WHERE source IS NULL AND grade = 'B';

UPDATE qr_batches SET source = 'QR_GENERATOR' WHERE source IS NULL AND grade IS NULL;

-- The Machine Program reads QR_GENERATOR runs grouped by product and colour.
CREATE INDEX IF NOT EXISTS idx_qr_batches_source_variant ON qr_batches(source, article_size_id, color);
