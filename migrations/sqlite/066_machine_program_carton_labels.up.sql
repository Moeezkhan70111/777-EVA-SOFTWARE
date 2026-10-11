-- Which issued packets of uppers have had their CARTON QR labels printed.
--
--   MP-000008 . 2 DOZEN of SK12 BLACK RED uppers out  ->  4 carton QR labels
--
-- Uppers going out of the store for a machine program are cartons coming back: 1 DOZEN is 2
-- cartons of 6 pairs. Machine Move Out has always offered to print those labels, but it only
-- remembered what it had printed for as long as the screen stayed open. Close the program and
-- the cartons were offered again -- and a carton QR is a permanent identity, so printing them
-- twice registers cartons that will never exist.
--
-- One row per issued packet that has been labelled. The packet is its STORE_EXIT event, not its
-- QR: a packet that comes back to the store and is issued again is a second issuance, owed its
-- own cartons. store_exit_event_id is the PRIMARY KEY, and that constraint IS the guarantee that
-- one issuance can never be labelled twice, whichever terminal asks.
--
-- qr_batch_id is the carton QR run the labels were generated in. Several packets of the same
-- upper are labelled together as one run, so several rows can share it. The row is written in the
-- same transaction as the run itself, so neither can exist without the other.
--
-- carton_count is how many of that run's cartons this packet accounts for, so a run can always
-- be traced back to the uppers that justified it.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS machine_program_carton_labels (
  store_exit_event_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  qr_batch_id TEXT NOT NULL,
  carton_count INTEGER NOT NULL,
  printed_by TEXT,
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (store_exit_event_id) REFERENCES raw_material_qr_events(id),
  FOREIGN KEY (program_id) REFERENCES machine_programs(id),
  FOREIGN KEY (qr_batch_id) REFERENCES qr_batches(id),
  CHECK (carton_count > 0)
);

CREATE INDEX IF NOT EXISTS idx_machine_program_carton_labels_program
  ON machine_program_carton_labels(program_id, created_at DESC);
