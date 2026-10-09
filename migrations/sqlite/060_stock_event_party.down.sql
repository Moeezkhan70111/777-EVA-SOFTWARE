-- Takes the party back off the stock ledger.
--
-- Nothing else points at the column, so it is simply dropped. Who delivered the material taken
-- in by hand is lost, which is what rolling the feature back means.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

DROP INDEX IF EXISTS idx_inventory_stock_events_party;

ALTER TABLE inventory_stock_events DROP COLUMN party_id;
