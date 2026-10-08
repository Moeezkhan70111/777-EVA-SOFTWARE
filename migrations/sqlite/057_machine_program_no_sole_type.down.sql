-- Puts NOT NULL back on machine_program_runs.sole_type_id by rebuilding the table again.
--
-- A run saved after 057 has no sole, so it cannot satisfy NOT NULL. Rather than invent a sole for
-- it, those runs are left out of the rebuilt table and their upper lines go with them: a program
-- that was planned without a sole is not a program the old shape can describe. Programs made
-- before 057 come back whole.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS machine_program_runs_restored (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  injector_no INTEGER NOT NULL,
  run_no INTEGER NOT NULL,
  sole_type_id TEXT NOT NULL,
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

INSERT INTO machine_program_runs_restored (
  id, program_id, injector_no, run_no, sole_type_id, sole_colour, article_size_id, created_by, created_at, updated_at
)
SELECT id, program_id, injector_no, run_no, sole_type_id, sole_colour, article_size_id, created_by, created_at, updated_at
  FROM machine_program_runs
 WHERE sole_type_id IS NOT NULL;

DELETE FROM machine_program_upper_lines
 WHERE run_id IN (SELECT id FROM machine_program_runs WHERE sole_type_id IS NULL);

DROP INDEX IF EXISTS idx_machine_program_runs_program;

DROP TABLE machine_program_runs;

ALTER TABLE machine_program_runs_restored RENAME TO machine_program_runs;

CREATE INDEX IF NOT EXISTS idx_machine_program_runs_program ON machine_program_runs(program_id, injector_no, run_no);
