-- Machine Program: a sole run is no longer described by a SOLE TYPE.
--
-- The program used to be built from four answers: the sole (SKECHERS, NIKE), the colour it is
-- moulded in, and the article + size it is moulded onto. The owner removed the first of them on
-- 2026-10-07: an injector is now described by the SOLE COLOUR, then the article, then the size.
--
--   before   sole -> sole colour -> article -> size
--   now      sole colour -> article -> size
--
-- machine_program_runs.sole_type_id was NOT NULL, so the column is made nullable rather than
-- dropped: the five runs already saved keep the sole they were made with, as history. Nothing
-- reads it any more, and nothing writes it. sole_types stays for the same reason -- it is the
-- target of that foreign key, and a saved run's sole name has to stay readable in the database.
--
-- SQLite cannot relax NOT NULL in place, so the table is rebuilt. Foreign keys are off for the
-- whole migration run (sqliteDatabase.runMigrations), so dropping a table
-- machine_program_upper_lines points at is safe, and the rename puts the name back for it.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS machine_program_runs_rebuilt (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  injector_no INTEGER NOT NULL,
  run_no INTEGER NOT NULL,
  sole_type_id TEXT,
  sole_colour TEXT NOT NULL,
  article_size_id TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (program_id) REFERENCES machine_programs(id),
  FOREIGN KEY (sole_type_id) REFERENCES sole_types(id),
  FOREIGN KEY (article_size_id) REFERENCES article_sizes(id),
  CHECK (injector_no IN (1, 2)),
  UNIQUE (program_id, injector_no, run_no)
);

INSERT INTO machine_program_runs_rebuilt (
  id, program_id, injector_no, run_no, sole_type_id, sole_colour, article_size_id, created_by, created_at, updated_at
)
SELECT id, program_id, injector_no, run_no, sole_type_id, sole_colour, article_size_id, created_by, created_at, updated_at
  FROM machine_program_runs;

DROP INDEX IF EXISTS idx_machine_program_runs_program;

DROP TABLE machine_program_runs;

ALTER TABLE machine_program_runs_rebuilt RENAME TO machine_program_runs;

CREATE INDEX IF NOT EXISTS idx_machine_program_runs_program ON machine_program_runs(program_id, injector_no, run_no);
