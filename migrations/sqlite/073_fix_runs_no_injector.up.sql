-- A FIX run belongs to the machine program, not to an injector.
--
--   a normal run   Injector 1 or 2 . BLACK sole . SK6 7/10 . uppers
--   a FIX run      no injector     . WHITE outer + BLACK inner . EVR9 7/10 . 32 DOZEN
--
-- The owner said it on 2026-10-12: "EVR FIX does not have injectors". Migration 067 put fix runs
-- on an injector because every run had one, so the screen asked for Injector 1 or 2 before it
-- knew the article was a fix article. A fix run now has NO injector, and the table says so:
--
--   inner_sole_colour IS NULL      ->  a normal run, and injector_no must be 1 or 2
--   inner_sole_colour IS NOT NULL  ->  a fix run, and injector_no must be NULL
--
-- injector_no IS NOT NULL is spelled out: a CHECK only refuses what is FALSE, and NULL IN (1, 2)
-- is NULL, which would let a normal run through with no injector at all.
--
-- SQLite cannot change a CHECK in place, so the table is rebuilt the way migration 057 did it,
-- keeping every column added since (067 fix columns, 070 time slot). Every fix run saved before
-- today simply loses its injector -- the rows, their ids and everything pointing at them (carton
-- labels, upper lines) stay exactly as they were.
--
-- UNIQUE (program_id, injector_no, run_no) still numbers the runs of an injector. SQLite counts
-- NULLs as distinct, so it says nothing about fix runs, whose one-run-per-article rule is the
-- save's job inside the write lock (SaveMachineProgramFixRunUseCase).
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS machine_program_runs_rebuilt (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  injector_no INTEGER,
  run_no INTEGER NOT NULL,
  sole_type_id TEXT,
  sole_colour TEXT NOT NULL,
  article_size_id TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  inner_sole_colour TEXT,
  quantity REAL,
  unit_id TEXT REFERENCES inventory_units(id),
  start_minute INTEGER,
  end_minute INTEGER,
  FOREIGN KEY (program_id) REFERENCES machine_programs(id),
  FOREIGN KEY (sole_type_id) REFERENCES sole_types(id),
  FOREIGN KEY (article_size_id) REFERENCES article_sizes(id),
  CHECK (
    (inner_sole_colour IS NULL AND injector_no IS NOT NULL AND injector_no IN (1, 2))
    OR (inner_sole_colour IS NOT NULL AND injector_no IS NULL)
  ),
  UNIQUE (program_id, injector_no, run_no)
);

INSERT INTO machine_program_runs_rebuilt (
  id, program_id, injector_no, run_no, sole_type_id, sole_colour, article_size_id,
  created_by, created_at, updated_at, inner_sole_colour, quantity, unit_id, start_minute, end_minute
)
SELECT id, program_id,
       CASE WHEN inner_sole_colour IS NULL THEN injector_no ELSE NULL END,
       run_no, sole_type_id, sole_colour, article_size_id,
       created_by, created_at, updated_at, inner_sole_colour, quantity, unit_id, start_minute, end_minute
  FROM machine_program_runs;

DROP INDEX IF EXISTS idx_machine_program_runs_program;

DROP INDEX IF EXISTS idx_machine_program_runs_fix;

DROP TABLE machine_program_runs;

ALTER TABLE machine_program_runs_rebuilt RENAME TO machine_program_runs;

CREATE INDEX IF NOT EXISTS idx_machine_program_runs_program ON machine_program_runs(program_id, injector_no, run_no);

CREATE INDEX IF NOT EXISTS idx_machine_program_runs_fix
  ON machine_program_runs(program_id) WHERE inner_sole_colour IS NOT NULL;
