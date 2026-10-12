-- The carton QR labels a FIX article's run is owed.
--
--   MP-000014 . DC3 7/10 . SILVER GREY outer + BLACK inner . 32 DOZEN  ->  64 carton QR labels
--
-- An ordinary article's cartons hang off an ISSUED PACKET of uppers (migration 068): uppers
-- going out of the store are cartons coming back, and the packet's STORE_EXIT event is what the
-- label is owed to. A FIX article has no upper -- it is moulded from two soles -- so nothing
-- ever leaves the store for it and no such event exists. Its cartons were therefore impossible
-- to print at all, which is the gap this closes.
--
-- What a fix run is owed is its PLAN: the quantity typed on the run, in dozens, two cartons to
-- the dozen, exactly the arithmetic every other carton follows.
--
-- One row per PRINT, not per run, because the quantity on a run can be raised later: a run
-- planned at 32 DOZEN and labelled, then raised to 40, is owed 16 more cartons and must be able
-- to get them. What can never happen is printing more than the plan -- the cartons still owed
-- are the plan minus the SUM of these rows, re-read inside the write lock, so two terminals
-- asking at once cannot between them print 65 cartons for 32 dozen.
--
-- The primary key is the run and the QR run together: a single carton batch can be recorded
-- against a fix run only once, so a reply lost on the way back cannot double-count a print that
-- did happen.
--
-- qr_batch_id is the carton QR run the labels were generated in, written in the same
-- transaction as the run itself, so neither can exist without the other. A carton scanned back
-- in at Store In is traced to its program through this table exactly as an upper's carton is
-- traced through machine_program_carton_labels.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS machine_program_fix_carton_labels (
  run_id TEXT NOT NULL,
  qr_batch_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  carton_count INTEGER NOT NULL,
  printed_by TEXT,
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, qr_batch_id),
  FOREIGN KEY (run_id) REFERENCES machine_program_runs(id),
  FOREIGN KEY (program_id) REFERENCES machine_programs(id),
  FOREIGN KEY (qr_batch_id) REFERENCES qr_batches(id),
  CHECK (carton_count > 0)
);

CREATE INDEX IF NOT EXISTS idx_machine_program_fix_carton_labels_program
  ON machine_program_fix_carton_labels(program_id, created_at DESC);
