-- A material's own ladder of units.
--
-- NAWAAR is counted in ROLLS, but a roll of one nawaar is 975 METRES and a roll of another is
-- not, so "1 ROLL = 975 METRE" is a fact about THAT material, not about the units. The global
-- inventory_unit_conversions table stays for conversions that are true everywhere, such as
-- 1 METRE = 40 INCH on the shop floor measure. This table is for the per-material ones.
--
-- A ladder is an ordered chain from the biggest unit down to the smallest:
--
--   step 0   1 ROLL  = 975 METRE
--   step 1   1 METRE =  40 INCH
--
-- The bottom of the chain is the BASE unit, and the base unit is the unit the material's
-- stock is held in. So the ladder never reinterprets a balance that is already recorded: it
-- only lets the store say the same number in bigger words, and type a count as "2 ROLL and
-- 37 INCH" instead of working out 78,037 by hand.
--
-- Each rung is stored rather than a single multiplier so the operator sees, edits and reasons
-- about the same steps the store actually uses.

CREATE TABLE IF NOT EXISTS inventory_item_unit_steps (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  -- 0 is the biggest unit. The chain must be unbroken: step n's from_unit is step n-1's
  -- to_unit, which the data layer enforces when a ladder is saved.
  step_order INTEGER NOT NULL,
  from_unit_id TEXT NOT NULL,
  to_unit_id TEXT NOT NULL,
  factor REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(item_id, step_order),
  FOREIGN KEY (item_id) REFERENCES inventory_items(id),
  FOREIGN KEY (from_unit_id) REFERENCES inventory_units(id),
  FOREIGN KEY (to_unit_id) REFERENCES inventory_units(id),
  CHECK (factor > 0),
  CHECK (step_order >= 0),
  CHECK (from_unit_id <> to_unit_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_item_unit_steps_item
  ON inventory_item_unit_steps(item_id, step_order);
