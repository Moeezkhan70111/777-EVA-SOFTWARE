-- Categories gain one level beneath them.
--
-- A category was a flat list: RUBBER UPPER, RAGZINE, DANA, BUCKLE. Real stores group finer
-- than that — DANA comes as EVA and as PVC, RAGZINE as PLAIN and as PRINTED — and until now
-- the only way to say so was another attribute, which is wrong: an attribute tells two
-- materials of the SAME kind apart, while a sub-category says they are different kinds that
-- happen to live together.
--
-- Modelled as a parent on the category itself rather than a second table, because a
-- sub-category IS a category: it has its own attributes, its own items and its own code. The
-- data layer holds it to exactly two levels — a sub-category may not itself have children —
-- so the tree can never become something nobody can navigate.
--
-- A sub-category INHERITS its parent's attributes and adds its own, so DANA's grade does not
-- have to be set up again on every kind of DANA. An item's identity is a hash over its
-- category id and its attribute values, and that id is the SUB-category's, so EVA grade A
-- and PVC grade A are two materials rather than a collision.
--
-- The table is rebuilt rather than altered because `name` and `category_code` carried
-- table-level UNIQUE constraints, and SQLite cannot drop those. A name only has to be unique
-- among its SIBLINGS now: PLAIN under RAGZINE and PLAIN under DANA are different things, and
-- the store calls them both PLAIN. parent_id deliberately carries no FOREIGN KEY, matching
-- the rest of this table, and the parent is validated in the data layer.

CREATE TABLE IF NOT EXISTS inventory_categories_v2 (
  id TEXT PRIMARY KEY,
  category_code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  -- NULL for a top-level category, or the parent's id for a sub-category.
  parent_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('ACTIVE','INACTIVE'))
);

INSERT OR IGNORE INTO inventory_categories_v2 (id, category_code, name, description, parent_id, status, created_by, created_at, updated_at)
SELECT id, category_code, name, description, NULL, status, created_by, created_at, updated_at
FROM inventory_categories;

DROP TABLE inventory_categories;

ALTER TABLE inventory_categories_v2 RENAME TO inventory_categories;

-- Unique among siblings, case-insensitively. COALESCE folds the NULL parent of a top-level
-- category into a comparable value, because SQLite treats every NULL as distinct in an index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_categories_sibling_name
  ON inventory_categories(COALESCE(parent_id, ''), UPPER(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_categories_sibling_code
  ON inventory_categories(COALESCE(parent_id, ''), category_code);
CREATE INDEX IF NOT EXISTS idx_inventory_categories_parent
  ON inventory_categories(parent_id, name);
