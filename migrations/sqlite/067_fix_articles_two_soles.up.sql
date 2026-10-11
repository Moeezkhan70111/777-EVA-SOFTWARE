-- FIX articles: no upper, two sole colours.
--
--   a normal article   BLACK sole  +  an UPPER going on it
--   a FIX article      OUTER sole  +  INNER sole, and no upper at all
--
-- The owner settled it on 2026-10-11: an EVR FIX chappal is moulded from two soles and has no
-- upper, so a machine program for one must not ask for uppers and must ask for the second
-- colour instead.
--
-- WHICH ARTICLES these are is a fact about the PRODUCT SUB GROUP, not a name in the code: the
-- sub group carries the flag, EVR FIX is ticked, and any fix sub group added later is ticked
-- too. Renaming EVR FIX therefore cannot quietly turn its articles back into upper articles.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

-- ---- The flag --------------------------------------------------------------
-- 0 for every sub group that exists, which is right: they are all upper articles today.
ALTER TABLE product_sub_groups ADD COLUMN has_no_upper INTEGER NOT NULL DEFAULT 0;

-- ---- The second sole, and what a run plans without upper lines -------------
-- A run's quantity has always been the sum of its UPPER LINES. A fix run has none, so the
-- figure is typed on the run itself. Both columns are NULL on every run saved before today and
-- on every normal run saved after it, which is what tells the two kinds apart:
--
--   inner_sole_colour IS NULL  ->  a normal run. sole_colour is THE sole, uppers carry the plan.
--   inner_sole_colour NOT NULL ->  a fix run. sole_colour is the OUTER sole, quantity is the plan.
--
-- quantity is NOT a reservation. A fix run holds nothing against store stock -- there is no
-- upper to promise and Dana has never been reserved by a program -- so none of the Reserved
-- arithmetic in machineProgramSql.ts looks at it, and Store Out has nothing to issue for it.
ALTER TABLE machine_program_runs ADD COLUMN inner_sole_colour TEXT;

ALTER TABLE machine_program_runs ADD COLUMN quantity REAL;

ALTER TABLE machine_program_runs ADD COLUMN unit_id TEXT REFERENCES inventory_units(id);

CREATE INDEX IF NOT EXISTS idx_machine_program_runs_fix
  ON machine_program_runs(program_id) WHERE inner_sole_colour IS NOT NULL;
