-- Takes FIX articles back off the machine program.
--
-- Every fix run saved keeps its outer sole (sole_colour) and its article, and loses its inner
-- sole and the quantity typed on it -- which is the whole plan for that run, so a program made
-- of fix runs reads as empty afterwards. Nothing that was reserved is affected, because a fix
-- run never reserved anything.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

DROP INDEX IF EXISTS idx_machine_program_runs_fix;

ALTER TABLE machine_program_runs DROP COLUMN unit_id;

ALTER TABLE machine_program_runs DROP COLUMN quantity;

ALTER TABLE machine_program_runs DROP COLUMN inner_sole_colour;

ALTER TABLE product_sub_groups DROP COLUMN has_no_upper;
