-- A saved set of conversions, reusable on any material.
--
-- "1 RULE = 975 METER, 1 METER = 39.7 INCH" is true of a whole family of nawaar, not of one
-- colour of it. Typing it again for every colour is how mistakes get in, so a set is saved
-- once by name and applied wherever it fits -- the same idea as a saved route through the
-- store (inventory_item_hops), which is already how the store reuses a setup.
--
-- The steps mirror inventory_item_unit_steps exactly, so a preset and a material's own ladder
-- are read and validated by the same code.

CREATE TABLE IF NOT EXISTS unit_ladder_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(name)
);

CREATE TABLE IF NOT EXISTS unit_ladder_preset_steps (
  id TEXT PRIMARY KEY,
  preset_id TEXT NOT NULL,
  -- 0 is the biggest unit. The chain must be unbroken, which the data layer enforces.
  step_order INTEGER NOT NULL,
  from_unit_id TEXT NOT NULL,
  to_unit_id TEXT NOT NULL,
  factor REAL NOT NULL,
  UNIQUE(preset_id, step_order),
  FOREIGN KEY (preset_id) REFERENCES unit_ladder_presets(id),
  FOREIGN KEY (from_unit_id) REFERENCES inventory_units(id),
  FOREIGN KEY (to_unit_id) REFERENCES inventory_units(id),
  CHECK (factor > 0),
  CHECK (step_order >= 0),
  CHECK (from_unit_id <> to_unit_id)
);

CREATE INDEX IF NOT EXISTS idx_unit_ladder_preset_steps_preset
  ON unit_ladder_preset_steps(preset_id, step_order);
