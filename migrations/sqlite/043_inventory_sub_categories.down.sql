DROP INDEX IF EXISTS idx_inventory_categories_parent;
DROP INDEX IF EXISTS idx_inventory_categories_sibling_code;
DROP INDEX IF EXISTS idx_inventory_categories_sibling_name;
-- Going back means restoring the table-level UNIQUE constraints, which only works if no two
-- categories share a name. Sub-categories must be renamed or removed first.
