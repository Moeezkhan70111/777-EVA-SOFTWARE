-- Store daily report: the day's typed stock movements are read by time, across every material.
-- The only index on inventory_stock_events by time was per material (item_id, created_at), so a
-- day's read walked the whole ledger. Additive only.
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE INDEX IF NOT EXISTS idx_inventory_stock_events_created_at ON inventory_stock_events(created_at);
