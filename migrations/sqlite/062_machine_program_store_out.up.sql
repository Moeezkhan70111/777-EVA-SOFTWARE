-- Store Out against a Machine Program: the BATCH a storekeeper saves.
--
--   MP-000012 open on Store Out
--     scan, scan, scan ...        nothing is written, nothing leaves the store
--     Save Batch                  ONE transaction: every packet out, every event stamped
--
-- Until today a packet found its program by itself: a plain Raw Material Output scan was
-- reconciled to the oldest program still owing that upper (migration 050, the
-- machine_program_upper_line_id stamp). That stays exactly as it is and is still the only thing
-- the generic store scanner does.
--
-- What is new is the other direction: the storekeeper OPENS a program and issues against it.
-- Two facts have nowhere to live in that flow:
--
--   1. which saved batch a packet left in -- the issue SESSION is this terminal's whole run, so
--      it cannot answer "what did this Save Batch commit", and a program is issued over several
--      batches across several days
--   2. the idempotency of a Save Batch -- a repeated request must not issue the same packets
--      twice, and the only safe way to know a request has already been served is to have
--      recorded the key it came with
--
-- Both are one row per saved batch, so this is one table and one stamp beside the line stamp.
-- Nothing is cached: issued and remaining are still recomputed from raw_material_qr_events
-- (machineProgramSql.ts LINE_CONSUMED_SQL), and this table never holds a quantity of its own.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

-- ---- One saved batch --------------------------------------------------------
-- batch_key is the key the renderer generated when the operator pressed Start Scan, and is
-- UNIQUE: that constraint IS the retry safety. A Save Batch that reaches the database twice --
-- a double click, an IPC retry, a terminal that lost the reply -- inserts this row once, and the
-- second attempt reads the row back and reports the batch it already saved.
--
-- session_id is the terminal's open Raw Material Output session, so a program batch still prints
-- on that session's issue slip like any other packet that left.
--
-- packet_count is how many packets the batch committed. It is a count of rows written in the
-- same transaction, not a quantity, so it can never disagree with a balance.
CREATE TABLE IF NOT EXISTS machine_program_issue_batches (
  id TEXT PRIMARY KEY,
  batch_key TEXT NOT NULL UNIQUE,
  program_id TEXT NOT NULL,
  session_id TEXT,
  device_id TEXT NOT NULL,
  issued_by TEXT,
  packet_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (program_id) REFERENCES machine_programs(id),
  FOREIGN KEY (session_id) REFERENCES raw_material_issue_sessions(id),
  CHECK (packet_count > 0)
);

CREATE INDEX IF NOT EXISTS idx_machine_program_issue_batches_program
  ON machine_program_issue_batches(program_id, created_at DESC);

-- ---- Which batch recorded an issuance --------------------------------------
-- Beside machine_program_upper_line_id, which says which ALLOCATION authorised the packet. The
-- line stamp answers "which program was this QR issued against" and this one answers "which
-- Save Batch committed it". A packet issued by the generic scanner carries the line stamp and no
-- batch, exactly as before, because no batch existed.
ALTER TABLE raw_material_qr_events ADD COLUMN machine_program_batch_id TEXT REFERENCES machine_program_issue_batches(id);

CREATE INDEX IF NOT EXISTS idx_raw_material_qr_events_program_batch
  ON raw_material_qr_events(machine_program_batch_id);
