-- What a material arrives in (PACKET, BAG, BOTTLE, ROLL) is a fact about its kind, not about
-- each material: every DANA comes in a BAG, every RAGZINE UPPER in a PACKET. So it is set on the
-- category or sub-category. A sub-category without one follows its parent, and a material whose
-- categories name none falls back to its own legacy inventory_items.pack_name, then to PACKET.
-- See EFFECTIVE_PACK_NAME_SQL in packages/data/src/database/shared.ts.
ALTER TABLE inventory_categories ADD COLUMN pack_name TEXT;
