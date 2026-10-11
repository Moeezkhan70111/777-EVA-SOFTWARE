-- Dana issued out of the store FOR a machine program.
--
--   MP-000008 . BLACK sole . 3 BAGS of EVA BLACK  ->  out of the store
--
-- A machine program has always RESERVED uppers and only shown Dana: Dana is what the sole is
-- moulded from, it is never promised to a program, and nothing on a program ever decided how
-- much of it left. The Machine Program Issue screen changes that last part only -- the
-- storekeeper now issues the day's Dana from the program itself, so the bags and the uppers
-- leave against the same document.
--
-- Dana is still NOT reserved. There is no allocation to consume and no outstanding quantity: a
-- program says which SOLE COLOURS it runs, and the operator says how many bags of which Dana of
-- that colour go out today. What this migration records is the movement, and which program it
-- was issued for.
--
-- It is one column, not a table. The movement itself is already a row in inventory_stock_events
-- -- the same ledger a hand move out writes, written by the same applyInventoryStockChange --
-- so a second table would be a second copy of a fact the ledger already holds. All that is
-- missing is WHICH PROGRAM, exactly as party_id was missing in migration 060.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE inventory_stock_events ADD COLUMN machine_program_id TEXT REFERENCES machine_programs(id);

-- "What did MP-000008 take out of the store?" reads this straight.
CREATE INDEX IF NOT EXISTS idx_inventory_stock_events_machine_program
  ON inventory_stock_events(machine_program_id, created_at DESC);
