-- 048 only dropped a table nothing reads. Recreate it exactly as 047 left it.
CREATE TABLE IF NOT EXISTS inventory_item_pack_sizes (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES inventory_items(id),
  quantity REAL NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (quantity > 0),
  UNIQUE(item_id, quantity)
);
CREATE INDEX IF NOT EXISTS idx_inventory_item_pack_sizes_item ON inventory_item_pack_sizes(item_id);
