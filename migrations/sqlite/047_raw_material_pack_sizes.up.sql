-- A material can arrive in more than one packet size. UPPER — RAGZINE UPPER — SK6 — BROWN — 7/10
-- comes some days 10 DOZEN to a packet and some days 5 DOZEN, and both are the same material.
--
-- inventory_items.packing_quantity stays the STANDARD packet (what screens divide a balance by).
-- This table holds the OTHER sizes the same packet can hold, in the same packing unit.
-- The label generator lets the operator pick one, and the chosen size is snapshotted onto each
-- printed QR (raw_material_qrs.packing_quantity) exactly as the standard one always was, so every
-- scan adds and removes what THAT packet actually holds.
CREATE TABLE IF NOT EXISTS inventory_item_pack_sizes (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES inventory_items(id),
  quantity REAL NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (quantity > 0),
  UNIQUE(item_id, quantity)
);

CREATE INDEX IF NOT EXISTS idx_inventory_item_pack_sizes_item ON inventory_item_pack_sizes(item_id);
