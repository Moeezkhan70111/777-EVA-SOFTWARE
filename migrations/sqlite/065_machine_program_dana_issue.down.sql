-- Takes the machine program back off the stock ledger.
--
-- The Dana that left the store stays out: the movement is an inventory_stock_events row and
-- this migration never touched the quantity on it. What is lost is which program each issue was
-- made for, which is what rolling the feature back means.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

DROP INDEX IF EXISTS idx_inventory_stock_events_machine_program;

ALTER TABLE inventory_stock_events DROP COLUMN machine_program_id;
