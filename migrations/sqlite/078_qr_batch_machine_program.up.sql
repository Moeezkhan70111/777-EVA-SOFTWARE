-- WHICH MACHINE PROGRAM A CARTON QR RUN WAS GENERATED FOR.
--
--   QR Generator   MACHINE 1  .  SK6 / 7/10 / BLACKGREY  x 10   ->   MP-000123  (MACHINE 1, 13 Oct)
--   QR Generator   MACHINE 1  .  SK6 / 7/10 / RED       x 4    ->   MP-000123  (same machine, same day)
--   B-Carton       MACHINE 2  .  EVR9 / 7/10 / MIX      x 3    ->   MP-000124  (MACHINE 2, 13 Oct)
--
-- From Phase 1.1 the QR Generator and the B-Carton Labels tab both ask for the machine first. A
-- machine has ONE program per business day (owner, 2026-10-13): the first run for it that day opens
-- the program in machine_programs -- numbered MP-000NNN, stamped with the machine and both of its
-- contractors as they stand at that moment -- and every later run that day joins it. The program is
-- opened in the same transaction as the run, so neither exists without the other, and the partial
-- unique index on (machine_id, program_date) from migration 050 keeps two terminals from opening two.
--
-- machine_program_id is NULL for every run made before this, and for the runs the retired
-- planning workflow printed (those are linked through machine_program_carton_labels instead).
-- Nothing is backfilled: no run made before Phase 1.1 said which machine it was for.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE qr_batches ADD COLUMN machine_program_id TEXT REFERENCES machine_programs(id);

CREATE INDEX IF NOT EXISTS idx_qr_batches_machine_program ON qr_batches(machine_program_id, article_size_id, color);
