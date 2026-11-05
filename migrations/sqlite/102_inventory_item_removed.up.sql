-- A removed material stays, marked (database/itemRemoval.ts). Its stock movements replicate as
-- append-only events, so deleting it left every other computer holding movements of a material
-- that could never be deleted there.
--
-- 102, not 100: 100 and 101 are taken on feat/cloud-accounts and feat/carton-stock. Migrations
-- apply by name, whatever has not been applied yet, so the gap on main is harmless.
ALTER TABLE inventory_items ADD COLUMN removed_at TEXT;
