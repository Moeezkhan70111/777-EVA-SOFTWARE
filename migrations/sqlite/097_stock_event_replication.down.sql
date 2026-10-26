-- Removes the arrival time and the kept-aside program id from stock events.
--
-- Dropping pending_machine_program_id loses which program an arrived Dana issue was for, and the
-- link could no longer be restored when programs replicate. Nothing else reads either column.
--
-- Nothing executes this file: the runner reads *.up.sql only. It exists so the forward migration
-- can be read against its inverse.
--
-- (No semicolons in comments.)

ALTER TABLE inventory_stock_events DROP COLUMN pending_machine_program_id;
ALTER TABLE inventory_stock_events DROP COLUMN replicated_at;
