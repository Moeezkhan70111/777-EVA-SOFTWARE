-- Raw material routes are gone.
--
-- Every raw material used to carry a route through the factory: an ordered list of sections a
-- packet travels when it leaves the store (inventory_item_hops), plus the first of them cached
-- on the material (inventory_items.default_section_id). Raw Material Output read that route to
-- decide where a packet went, and refused any material that had none.
--
-- The owner removed it on 2026-10-07: a packet is now simply taken out of the store, and where
-- it goes afterwards is not something the store records. The feature was configured but never
-- used -- 285 materials had a route, all one hop to the single destination PACKING, and not one
-- packet had ever been issued -- so no history is lost here.
--
-- work_sections stays: machines still stand in one, and a machine program is still a program
-- for a machine in a section.
--
-- inventory_items.default_section_id is emptied rather than dropped. Removing a column means
-- rebuilding inventory_items, which half the database points at, and the column is harmless
-- once nothing reads or writes it.

UPDATE inventory_items SET default_section_id = NULL WHERE default_section_id IS NOT NULL;

DROP INDEX IF EXISTS idx_inventory_item_hops_item;
DROP TABLE IF EXISTS inventory_item_hops;
