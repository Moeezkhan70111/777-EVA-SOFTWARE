-- Raw material routes: the ordered hops a material makes after it leaves the store.
--
-- Until now a material had ONE destination (inventory_items.default_section_id), so a
-- packet was issued once and that was the end of it. Real material does not work that way:
-- ragzine goes to the upper maker, then to stitching, then to packing. Each of those is a
-- hop, and the storekeeper scans the packet at each one.
--
-- The route belongs to the material, so the operator still never chooses a destination:
-- scanning a packet on Raw Material Output sends it to whichever hop is next for it.

CREATE TABLE IF NOT EXISTS inventory_item_hops (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  -- 1-based position along the route. Unique per item so two hops cannot share a place.
  hop_index INTEGER NOT NULL,
  section_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(item_id, hop_index),
  FOREIGN KEY (item_id) REFERENCES inventory_items(id),
  FOREIGN KEY (section_id) REFERENCES work_sections(id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_item_hops_item ON inventory_item_hops(item_id, hop_index);

-- How far along its route a packet has travelled. 0 means it has not been issued yet, so
-- the next scan sends it to hop 1. Reset to 0 whenever the store receives the packet back,
-- because a packet that has come home starts its route again.
ALTER TABLE raw_material_qrs ADD COLUMN current_hop_index INTEGER NOT NULL DEFAULT 0;

-- Every material that already had a single destination keeps it, as hop 1 of its route.
-- Nothing configured is lost and no material silently becomes unroutable.
INSERT INTO inventory_item_hops (id, item_id, hop_index, section_id, created_at, updated_at)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' ||
       lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' ||
       lower(hex(randomblob(6))),
       ii.id, 1, ii.default_section_id,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM inventory_items ii
WHERE ii.default_section_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM inventory_item_hops h WHERE h.item_id = ii.id);

-- A packet already sitting at its (single) destination is at hop 1 of that route.
UPDATE raw_material_qrs SET current_hop_index = 1 WHERE current_status = 'ISSUED';
