-- B CARTONS: EVR FIX cartons that came back as B — mixed colours — and are labelled again.
--
--   MP-000012  EVR9 7/10  20 carton labels printed (BLACK)  ->  10 came back
--   Reconciliation: "10 B cartons"  ->  the 10 BLACK labels not back are VOIDED and
--                                       10 new labels EVR9 / MIX / 7/10, grade B, are printed
--   Store In scans the 10 B cartons  ->  20 of 20 back, the program completes
--
-- The owner asked for it on 2026-10-12: a carton that comes off the machine in mixed colours is a
-- B carton, so its colour label no longer tells the truth. Its label is replaced by one that says
-- MIX and carries a B, and THAT is the carton that comes back to the store.
--
-- qr_batches.grade marks a run of B labels. NULL is an ordinary run. It lives on the batch so a
-- reprint of a B run prints B again, and so anything later (stock, billing at the B-type price)
-- can tell a B carton from an ordinary MIX one without guessing from the colour.
--
-- machine_program_b_conversions is the record of which label became which B run. Its PRIMARY KEY
-- on the original label is the guarantee that one label is converted at most once, whichever
-- terminal asks. The original is VOIDED in qr_codes in the same transaction, so it can never be
-- stored in afterwards and be counted twice. The B run is linked to the program and its FIX run
-- through machine_program_fix_carton_labels (migration 071), exactly as the first print was, so
-- Carton In and the program's counts read it with nothing new to learn.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE qr_batches ADD COLUMN grade TEXT CHECK (grade IS NULL OR grade = 'B');

CREATE TABLE IF NOT EXISTS machine_program_b_conversions (
  original_qr_id TEXT PRIMARY KEY,
  b_qr_batch_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  converted_by TEXT,
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (original_qr_id) REFERENCES qr_codes(id),
  FOREIGN KEY (b_qr_batch_id) REFERENCES qr_batches(id),
  FOREIGN KEY (program_id) REFERENCES machine_programs(id),
  FOREIGN KEY (run_id) REFERENCES machine_program_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_machine_program_b_conversions_program
  ON machine_program_b_conversions(program_id, run_id);
