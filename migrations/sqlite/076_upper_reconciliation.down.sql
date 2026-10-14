-- Takes the upper reconciliation back out. Claims and upper B labels go with their tables, and the
-- reconciliation lines go back to the three-way rule, keeping only the rows that rule allows.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

DROP INDEX IF EXISTS idx_party_claims_program;
DROP INDEX IF EXISTS idx_party_claims_party;
DROP TABLE IF EXISTS party_claims;

DROP INDEX IF EXISTS idx_machine_program_upper_b_labels_line;
DROP TABLE IF EXISTS machine_program_upper_b_labels;

CREATE TABLE IF NOT EXISTS machine_program_reconciliation_lines_old (
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

INSERT INTO machine_program_reconciliation_lines_old
  (id, program_id, upper_line_id, item_id, cartons_due, cartons_back, shortfall_uppers,
   cut_size_uppers, wastage_uppers, wastage_party_id, wastage_reason,
   lost_uppers, lost_role, lost_party_id, lost_reason, created_at)
SELECT id, program_id, upper_line_id, item_id, cartons_due, cartons_back, shortfall_uppers,
       cut_size_uppers, wastage_uppers, wastage_party_id, wastage_reason,
       lost_uppers, lost_role, lost_party_id, lost_reason, created_at
FROM machine_program_reconciliation_lines
WHERE cut_size_pairs = 0 AND claimed_pairs = 0;

DROP TABLE machine_program_reconciliation_lines;

ALTER TABLE machine_program_reconciliation_lines_old RENAME TO machine_program_reconciliation_lines;

CREATE INDEX IF NOT EXISTS idx_machine_program_reconciliation_lines_program
  ON machine_program_reconciliation_lines(program_id);
