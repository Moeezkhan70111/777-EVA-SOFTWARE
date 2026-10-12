-- Takes the per-sole time slot back off a run.
--
-- Every run keeps its injector, its sole, its article and its quantity. What is lost is when
-- each sole was to run, and the programs then read as they did before: the shift says how long
-- the machine runs, and nothing says which sole is on it when.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE machine_program_runs DROP COLUMN end_minute;

ALTER TABLE machine_program_runs DROP COLUMN start_minute;
