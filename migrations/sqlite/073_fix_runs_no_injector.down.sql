-- Puts fix runs back on an injector (Injector 1), as migration 067 had them.
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
  inner_sole_colour TEXT,
  quantity REAL,
  unit_id TEXT REFERENCES inventory_units(id),
  start_minute INTEGER,
  end_minute INTEGER,
  FOREIGN KEY (program_id) REFERENCES machine_programs(id),
  FOREIGN KEY (sole_type_id) REFERENCES sole_types(id),
  FOREIGN KEY (article_size_id) REFERENCES article_sizes(id),
  CHECK (injector_no IN (1, 2)),
  UNIQUE (program_id, injector_no, run_no)
);

INSERT INTO machine_program_runs_rebuilt (
  id, program_id, injector_no, run_no, sole_type_id, sole_colour, article_size_id,
  created_by, created_at, updated_at, inner_sole_colour, quantity, unit_id, start_minute, end_minute
)
SELECT id, program_id, COALESCE(injector_no, 1),
       CASE WHEN injector_no IS NULL
            THEN 1000 + run_no
            ELSE run_no END,
       sole_type_id, sole_colour, article_size_id,
       created_by, created_at, updated_at, inner_sole_colour, quantity, unit_id, start_minute, end_minute
  FROM machine_program_runs;

DROP INDEX IF EXISTS idx_machine_program_runs_program;

DROP INDEX IF EXISTS idx_machine_program_runs_fix;

DROP TABLE machine_program_runs;

ALTER TABLE machine_program_runs_rebuilt RENAME TO machine_program_runs;

CREATE INDEX IF NOT EXISTS idx_machine_program_runs_program ON machine_program_runs(program_id, injector_no, run_no);

CREATE INDEX IF NOT EXISTS idx_machine_program_runs_fix
  ON machine_program_runs(program_id) WHERE inner_sole_colour IS NOT NULL;
