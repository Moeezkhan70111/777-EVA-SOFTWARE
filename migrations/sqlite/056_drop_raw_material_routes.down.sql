-- Puts the table back, empty. The routes themselves cannot be restored: this migration deleted
-- them, and nothing else holds a copy.
CREATE TABLE IF NOT EXISTS inventory_item_hops (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  hop_index INTEGER NOT NULL,
  section_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(item_id, hop_index),
  FOREIGN KEY (item_id) REFERENCES inventory_items(id),
  FOREIGN KEY (section_id) REFERENCES work_sections(id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_item_hops_item ON inventory_item_hops(item_id, hop_index);
