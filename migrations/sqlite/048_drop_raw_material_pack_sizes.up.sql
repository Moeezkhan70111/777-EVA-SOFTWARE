-- Reverts 047. The other-pack-sizes list was replaced the same day by a figure the operator
-- types on every label run (raw_material_qrs.packing_quantity), so a material no longer keeps
-- a list of sizes anywhere. Nothing reads this table.
DROP INDEX IF EXISTS idx_inventory_item_pack_sizes_item;
DROP TABLE IF EXISTS inventory_item_pack_sizes;
