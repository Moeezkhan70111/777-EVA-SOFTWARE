-- The product code's column and its uniqueness become a recorded migration instead of a silent
-- code path.
--
--   PRD-000001 is allocated as MAX(SUBSTR(product_code, 5)) + 1 and shown on the Product form,
--   so two products must never share one code.
--
-- Until now BOTH the column and its unique index existed ONLY in sqliteDatabase.ts
-- ensureSchemaCompatibility, inside try/catch blocks that swallow every failure. A guarantee
-- created that way is not recorded in schema_migrations, is not verifiable after the fact, and
-- would be silently absent if the statement ever failed. Recorded here it is ordered and
-- checkable.
--
-- Both statements are written to be safe on a database that already has them. The ALTER is a
-- plain ADD COLUMN because SQLite has no IF NOT EXISTS for one -- the migration runner ignores a
-- "duplicate column name" error specifically for this case, so an existing database skips it and
-- a fresh one gains the column here, before the index needs it. Note the ordering: migrations
-- run BEFORE ensureSchemaCompatibility, so on a brand new database this migration is where
-- product_code first appears.
--
-- The partial WHERE clause matches the existing index definition exactly: a product with no code
-- yet is not part of the series. Nothing is renumbered and no product code changes.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE article_sizes ADD COLUMN product_code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_article_sizes_product_code
  ON article_sizes(product_code) WHERE product_code IS NOT NULL;
