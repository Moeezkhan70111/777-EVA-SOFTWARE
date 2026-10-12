-- When each SOLE runs, inside the machine's shift.
--
--   MACHINE 1 . 12 Oct . 06:00 AM - 06:00 PM          the shift, on the program
--     Injector 1
--       BLACK sole   06:00 AM - 10:00 AM              <- this
--       BROWN sole   10:00 AM - 06:00 PM              <- this
--
-- The owner asked for it on 2026-10-12: the shift alone says how long the MACHINE runs, not
-- which sole is on it when. A minder standing at the machine needs the second answer.
--
-- Minutes from midnight of program_date, the same convention the shift itself uses (migration
-- 058), so a slot that runs past midnight is just an end above 1440 and no screen ever does
-- timezone arithmetic of its own.
--
-- Both NULL on every run saved before today and on every run nobody has timed: a sole with no
-- slot simply runs the whole shift, which is what one sole on an injector has always meant.
--
-- The slot is on the RUN because that is the only row a sole colour has. Every run of one
-- colour on one injector is written with the same slot, so the sole card has one answer rather
-- than one per article -- SaveMachineProgramSoleSlotUseCase is what keeps that true.
--
-- It plans time, not stock: nothing here reserves anything, and no quantity, balance or event
-- depends on it.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE machine_program_runs ADD COLUMN start_minute INTEGER;

ALTER TABLE machine_program_runs ADD COLUMN end_minute INTEGER;
