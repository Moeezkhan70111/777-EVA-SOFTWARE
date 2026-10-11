-- Contractor pricing on a machine program: what the day's work is paid at, per ARTICLE.
--
--   MP-000011  MACHINE 1  10 Oct
--     SK6  7/10    machine 45.00   packing 18.00   printing 12.00     per DOZEN
--     SK12 1/6     machine 52.00   packing 20.00   printing  0.00     per DOZEN
--
-- A machine is run under one contractor and its output packed under another (migration 059), and
-- the day is paid against both. What it is paid AT belongs to neither of them: it is a property
-- of the article being made, because a bigger slipper is more work than a smaller one and the
-- same contractor is paid differently for each. So the rates hang off the program and the
-- article, not off the party.
--
-- ONE ROW PER ARTICLE ON THE PROGRAM, not per run. The same article can be moulded on two sole
-- colours or on both injectors, and to the person paying it is one article at one rate -- two
-- runs of SK6 7/10 can never drift to two different machine rates.
--
-- PRINTING has no contractor of its own yet (owner's decision, 2026-10-10): it is a rate the
-- program carries so the cost is recorded, and a printing party can be attached later without
-- touching what is stored here.
--
-- MONEY IS INTEGER PAISA (R15). These are per-DOZEN rates: 45.00 per dozen is 4500. There are no
-- REAL rupee siblings -- this table is new, so it starts where the rest of the books are going.
--
-- NO AMOUNT IS STORED. What a contractor is owed is rate x quantity, and the quantity it will be
-- owed on is production, which this ERP does not yet record against a program. Storing an amount
-- now would freeze a figure nobody has earned. The rates are the fact, and the amount is derived
-- wherever it is shown (@erp/domain contractorPricing.ts).
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS machine_program_article_rates (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  article_size_id TEXT NOT NULL,
  machine_rate_paisa INTEGER NOT NULL DEFAULT 0,
  packing_rate_paisa INTEGER NOT NULL DEFAULT 0,
  printing_rate_paisa INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (program_id) REFERENCES machine_programs(id),
  FOREIGN KEY (article_size_id) REFERENCES article_sizes(id),
  CHECK (machine_rate_paisa >= 0),
  CHECK (packing_rate_paisa >= 0),
  CHECK (printing_rate_paisa >= 0)
);

-- The pricing is always read for one whole program at a time (the program screen, its printed
-- sheet), and written one article at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_machine_program_article_rates_article
  ON machine_program_article_rates(program_id, article_size_id);
