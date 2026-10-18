-- Drops only the index this migration recorded. No product code and no row is touched.
--
-- Note that ensureSchemaCompatibility would recreate the same index on the next boot, because
-- that older code path has not been removed -- the point of migration 081 is to record the
-- guarantee, not to move it.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

DROP INDEX IF EXISTS idx_article_sizes_product_code;
