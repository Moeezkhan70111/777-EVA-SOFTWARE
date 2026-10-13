-- Carton QR labels are owed by what a program PLANS, not by the packets the store issued.
--
--   MP-000003 . SK46 4/6 . GREY upper . 4.5 DOZEN planned  ->  9 carton QR labels
--
-- Uppers leave the store in whole packets (3 DOZEN here), so what is issued can never add up to
-- a plan of 4.5 DOZEN: two packets made 6 DOZEN and the floor was offered 12 cartons, while one
-- packet made 3 DOZEN and it was offered 6. The program said 4.5 DOZEN either way, which is 9
-- cartons (owner, 2026-10-14). The plan is the authority, exactly as it already is for a FIX
-- article, whose cartons never had a packet to be owed to.
--
-- One row per upper LINE that has been labelled, instead of one per issued packet (068). A line
-- may be labelled more than once as its plan grows, so the key is the line and the run it was
-- labelled in, and the owed figure is the plan minus the sum of these rows -- re-read inside the
-- write lock, so two terminals can never between them print more cartons than the line plans.
--
-- 068's rows are kept and still counted: they are the record of cartons already printed for this
-- program, and each one resolves to its line through its STORE_EXIT event.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS machine_program_line_carton_labels (
  upper_line_id TEXT NOT NULL,
  qr_batch_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  carton_count INTEGER NOT NULL,
  printed_by TEXT,
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (upper_line_id, qr_batch_id),
  FOREIGN KEY (upper_line_id) REFERENCES machine_program_upper_lines(id),
  FOREIGN KEY (program_id) REFERENCES machine_programs(id),
  FOREIGN KEY (qr_batch_id) REFERENCES qr_batches(id),
  CHECK (carton_count > 0)
);

CREATE INDEX IF NOT EXISTS idx_machine_program_line_carton_labels_program
  ON machine_program_line_carton_labels(program_id, created_at DESC);
