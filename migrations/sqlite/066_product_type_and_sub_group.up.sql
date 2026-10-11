-- Two more ways a product is classified: its TYPE, and the SUB GROUP inside its product group.
--
--   Main Group        CHAPPAL
--   Product Group     GENTS
--   Product Sub Group GENTS CASUAL     <- new, and it belongs to GENTS
--   Article Series    SK
--   Product Type      MOULDED          <- new, a list of its own
--
-- Product Type is a flat list, exactly like main_groups: a product is of a type whatever group
-- it sits in. Product Sub Group is NOT flat -- the owner said a sub group belongs to a product
-- group (2026-10-11), so it carries its parent and the form only offers the sub groups of the
-- group that is chosen.
--
-- Both mirror the shape the existing lists already use (main_groups, product_groups,
-- article_series), down to the soft-delete columns, so the Product Lists page can rename and
-- delete them with the machinery that is already there rather than a second kind of list.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

-- ---- Product type -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_product_types_name ON product_types(name);

-- ---- Product sub group, under its product group -----------------------------
-- The name is unique WITHIN a group, not globally: "CASUAL" under GENTS and "CASUAL" under
-- LADIES are two different sub groups, and the floor says them with their group.
--
-- ON DELETE is deliberately NOT cascaded. Deleting a product group is already a guarded
-- operation (deleteProductListEntry refuses one that is still in use), and a sub group left
-- pointing at a group that is gone would be a silent data loss rather than a refusal.
CREATE TABLE IF NOT EXISTS product_sub_groups (
  id TEXT PRIMARY KEY,
  product_group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT,
  FOREIGN KEY (product_group_id) REFERENCES product_groups(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_sub_groups_name
  ON product_sub_groups(product_group_id, name);
CREATE INDEX IF NOT EXISTS idx_product_sub_groups_group ON product_sub_groups(product_group_id);

-- ---- What a product is classified as ----------------------------------------
-- Both nullable: every product saved before today has neither, and a product does not have to
-- be classified to exist. article_sizes is the Product Master row and product_variants keeps
-- its own copy of these fields, the way it already does for the main group, the product group
-- and the series -- the sale, discount and report queries read them off the variant.
ALTER TABLE article_sizes ADD COLUMN product_type_id TEXT REFERENCES product_types(id);

ALTER TABLE article_sizes ADD COLUMN product_sub_group_id TEXT REFERENCES product_sub_groups(id);

ALTER TABLE product_variants ADD COLUMN product_type_id TEXT REFERENCES product_types(id);

ALTER TABLE product_variants ADD COLUMN product_sub_group_id TEXT REFERENCES product_sub_groups(id);

CREATE INDEX IF NOT EXISTS idx_article_sizes_product_type ON article_sizes(product_type_id);
CREATE INDEX IF NOT EXISTS idx_article_sizes_product_sub_group ON article_sizes(product_sub_group_id);
