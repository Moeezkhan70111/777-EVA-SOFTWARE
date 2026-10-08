-- Takes the shift back off machine_programs.
--
-- Nothing else points at these two columns, so they are simply dropped. Which shift a program
-- was planned for is lost, which is what rolling the feature back means.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE machine_programs DROP COLUMN shift_start_minute;

ALTER TABLE machine_programs DROP COLUMN shift_end_minute;
