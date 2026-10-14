-- Reconciling an UPPER line of a machine program (everything but EVR FIX, which is unchanged).
--
--   6 DOZEN out = 12 cartons due, 6 back, 6 missing = 36 pairs. Before closing:
--     RETURN UPPER   a sealed packet scanned back in   (raw_material_qr_events, as before)
--     B CARTON       MIX labels printed for the line   (machine_program_upper_b_labels, new)
--   and on closing, what is left:
--     CUT SIZE UPPER / CUT SIZE PAIRS                  (the two cut size columns)
--     CLAIM          pairs x an amount, against the supplier or a contractor, deducted on their
--                    ledger                            (party_claims, new)
--
-- (No semicolons in comments: the migration runner splits statements on them.)

-- ---- The reconciliation line, with the new ways in its rule -------------------
-- SQLite cannot change a CHECK, so the table is rebuilt: create new / copy / drop old / rename,
-- run by the migration runner with foreign keys off. Old rows keep their meaning exactly:
-- cut_size_pairs and claimed_pairs are 0 on them, so their sums are unchanged.
CREATE TABLE IF NOT EXISTS machine_program_reconciliation_lines_new (
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
  cut_size_pairs INTEGER NOT NULL DEFAULT 0,
  claimed_pairs INTEGER NOT NULL DEFAULT 0,
  returned_upper_pairs INTEGER NOT NULL DEFAULT 0,
  b_cartons INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (program_id) REFERENCES machine_program_closures(program_id),
  FOREIGN KEY (upper_line_id) REFERENCES machine_program_upper_lines(id),
  FOREIGN KEY (item_id) REFERENCES inventory_items(id),
  FOREIGN KEY (wastage_party_id) REFERENCES parties(id),
  FOREIGN KEY (lost_party_id) REFERENCES parties(id),
  UNIQUE (program_id, upper_line_id),
  CHECK (cut_size_uppers >= 0 AND wastage_uppers >= 0 AND lost_uppers >= 0),
  CHECK (cut_size_pairs >= 0 AND claimed_pairs >= 0 AND returned_upper_pairs >= 0 AND b_cartons >= 0),
  CHECK (cut_size_uppers + cut_size_pairs + wastage_uppers + lost_uppers + claimed_pairs = shortfall_uppers),
  CHECK (wastage_uppers = 0 OR (wastage_party_id IS NOT NULL AND TRIM(COALESCE(wastage_reason, '')) <> '')),
  CHECK (lost_uppers = 0 OR (lost_party_id IS NOT NULL AND lost_role IN ('MACHINE','PACKING') AND TRIM(COALESCE(lost_reason, '')) <> ''))
);

INSERT INTO machine_program_reconciliation_lines_new
  (id, program_id, upper_line_id, item_id, cartons_due, cartons_back, shortfall_uppers,
   cut_size_uppers, wastage_uppers, wastage_party_id, wastage_reason,
   lost_uppers, lost_role, lost_party_id, lost_reason, created_at)
SELECT id, program_id, upper_line_id, item_id, cartons_due, cartons_back, shortfall_uppers,
       cut_size_uppers, wastage_uppers, wastage_party_id, wastage_reason,
       lost_uppers, lost_role, lost_party_id, lost_reason, created_at
FROM machine_program_reconciliation_lines;

DROP TABLE machine_program_reconciliation_lines;

ALTER TABLE machine_program_reconciliation_lines_new RENAME TO machine_program_reconciliation_lines;

CREATE INDEX IF NOT EXISTS idx_machine_program_reconciliation_lines_program
  ON machine_program_reconciliation_lines(program_id);

-- ---- B cartons of an upper line --------------------------------------------
-- One row per B label run. The run is MIX, grade B (qr_batches.grade), for the line's article
-- and size. Which original label each B replaced stays in machine_program_b_conversions, as for
-- EVR FIX, with the line's run as its run.
CREATE TABLE IF NOT EXISTS machine_program_upper_b_labels (
  qr_batch_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  upper_line_id TEXT NOT NULL,
  carton_count INTEGER NOT NULL,
  printed_by TEXT,
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (qr_batch_id) REFERENCES qr_batches(id),
  FOREIGN KEY (program_id) REFERENCES machine_programs(id),
  FOREIGN KEY (upper_line_id) REFERENCES machine_program_upper_lines(id),
  CHECK (carton_count > 0)
);

CREATE INDEX IF NOT EXISTS idx_machine_program_upper_b_labels_line
  ON machine_program_upper_b_labels(program_id, upper_line_id);

-- ---- Claims ------------------------------------------------------------------
-- A claim is a deduction from what we owe the party: it stands on the supplier ledger and the
-- contractor ledger as a debit. Money is integer paisa, and the amount is the pairs times the
-- amount a pair, checked here so it can never drift. A claim is never deleted: REVERSED takes it
-- off the ledgers and keeps who reversed it and why.
CREATE TABLE IF NOT EXISTS party_claims (
  id TEXT PRIMARY KEY,
  claim_number TEXT NOT NULL UNIQUE,
  party_id TEXT NOT NULL,
  party_role TEXT NOT NULL,
  program_id TEXT NOT NULL,
  upper_line_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity_pairs INTEGER NOT NULL,
  rate_paisa INTEGER NOT NULL,
  amount_paisa INTEGER NOT NULL,
  reason TEXT NOT NULL,
  claim_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'POSTED',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reversed_by TEXT,
  reversed_at TEXT,
  reversal_reason TEXT,
  FOREIGN KEY (party_id) REFERENCES parties(id),
  FOREIGN KEY (program_id) REFERENCES machine_programs(id),
  FOREIGN KEY (upper_line_id) REFERENCES machine_program_upper_lines(id),
  FOREIGN KEY (item_id) REFERENCES inventory_items(id),
  CHECK (party_role IN ('SUPPLIER','MACHINE','PACKING')),
  CHECK (status IN ('POSTED','REVERSED')),
  CHECK (quantity_pairs > 0 AND rate_paisa > 0),
  CHECK (amount_paisa = quantity_pairs * rate_paisa),
  CHECK (TRIM(reason) <> '')
);

CREATE INDEX IF NOT EXISTS idx_party_claims_party ON party_claims(party_id, claim_date);
CREATE INDEX IF NOT EXISTS idx_party_claims_program ON party_claims(program_id);
