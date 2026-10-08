-- Machine Program: a program now says which SHIFT it is for.
--
--   MACHINE 1 . 8 Oct 2026 . 06:00 AM - 06:00 PM
--
-- The owner asked for the shift on 2026-10-08. A program already belongs to one machine on one
-- date, so the shift is a fact about that program, not a second key: a machine still has one
-- program per date, and changing its shift never touches a reservation.
--
-- Minutes from midnight of program_date, exactly as the first shape of this feature held its
-- time slots in machine_program_lines. end_minute may pass 1440, which is what an evening shift
-- finishing the next morning does, so "runs into tomorrow" stays an integer comparison and no
-- screen does timezone arithmetic of its own.
--
-- Existing programs get the day shift, which is the shift the floor runs by default.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE machine_programs ADD COLUMN shift_start_minute INTEGER NOT NULL DEFAULT 360;

ALTER TABLE machine_programs ADD COLUMN shift_end_minute INTEGER NOT NULL DEFAULT 1080;
