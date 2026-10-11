-- Closing a machine program against the cartons that came back, and RECONCILING when they are short.
--
--   4 DOZEN of uppers issued  ->  8 cartons due  (1 DOZEN = 2 cartons)
--   8 back  ->  closed COMPLETE
--   7 back  ->  1 carton = 6 uppers to account for: CUT SIZE (came back to the store),
--               WASTAGE (claimed to the upper's supplier) or LOST (claimed to the machine or the
--               packing contractor), every claim with its reason
--
-- Closing also sets the program's status to COMPLETED -- the status that already means "holds no
-- reservation" -- so uppers planned but never issued are released, and nothing more can be issued
-- against it. The closure row is what says it was closed on PURPOSE, by whom, and how. It is the
-- PRIMARY KEY on program_id, so a program can be closed exactly once.
--
-- Counted in UPPERS (pairs), never dozens: 4 uppers is a third of a dozen, which a two-decimal
-- dozen cannot hold exactly. The carton figures are kept as they were at the moment of closing.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS machine_program_closures (
  program_id TEXT PRIMARY KEY,
  outcome TEXT NOT NULL,
  cartons_due INTEGER NOT NULL,
  cartons_back INTEGER NOT NULL,
  closed_by TEXT NOT NULL,
  device_id TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  FOREIGN KEY (program_id) REFERENCES machine_programs(id),
  CHECK (outcome IN ('COMPLETE','RECONCILED')),
  CHECK (cartons_back <= cartons_due)
);

-- One row per upper line that came back short. cut_size + wastage + lost = shortfall, exactly.
-- wastage_party_id is the upper's supplier, lost_party_id the contractor it is claimed against
-- (lost_role says which job: MACHINE or PACKING). A reason is kept with every claim.
CREATE TABLE IF NOT EXISTS machine_program_reconciliation_lines (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  upper_line_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  cartons_due INTEGER NOT NULL,
  cartons_back INTEGER NOT NULL,
  shortfall_uppers INTEGER NOT NULL,
  cut_size_uppers INTEGER NOT NULL DEFAULT 0,
  wastage_uppers INTEGER NOT NULL DEFAULT 0,
  wastage_party_id TEXT,
  wastage_reason TEXT,
  lost_uppers INTEGER NOT NULL DEFAULT 0,
  lost_role TEXT,
  lost_party_id TEXT,
  lost_reason TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (program_id) REFERENCES machine_program_closures(program_id),
  FOREIGN KEY (upper_line_id) REFERENCES machine_program_upper_lines(id),
  FOREIGN KEY (item_id) REFERENCES inventory_items(id),
  FOREIGN KEY (wastage_party_id) REFERENCES parties(id),
  FOREIGN KEY (lost_party_id) REFERENCES parties(id),
  UNIQUE (program_id, upper_line_id),
  CHECK (cut_size_uppers >= 0 AND wastage_uppers >= 0 AND lost_uppers >= 0),
  CHECK (cut_size_uppers + wastage_uppers + lost_uppers = shortfall_uppers),
  CHECK (wastage_uppers = 0 OR (wastage_party_id IS NOT NULL AND TRIM(COALESCE(wastage_reason, '')) <> '')),
  CHECK (lost_uppers = 0 OR (lost_party_id IS NOT NULL AND lost_role IN ('MACHINE','PACKING') AND TRIM(COALESCE(lost_reason, '')) <> ''))
);

CREATE INDEX IF NOT EXISTS idx_machine_program_reconciliation_lines_program
  ON machine_program_reconciliation_lines(program_id);
