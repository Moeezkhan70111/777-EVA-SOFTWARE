CREATE TABLE IF NOT EXISTS article_size_migration_diagnostics (
  id TEXT PRIMARY KEY,
  article TEXT NOT NULL,
  size TEXT NOT NULL,
  field_name TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO article_size_migration_diagnostics (id, article, size, field_name, details_json, created_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))),
  pv.article,
  pv.size,
  'selling_price',
  json_object('values', group_concat(DISTINCT COALESCE(CAST(pv.selling_price AS TEXT), 'NULL'))),
  CURRENT_TIMESTAMP
FROM product_variants pv
WHERE pv.deleted_at IS NULL
GROUP BY pv.article, pv.size
HAVING (
     COUNT(DISTINCT CASE WHEN pv.selling_price IS NOT NULL THEN pv.selling_price END) > 1
     OR COUNT(pv.selling_price) <> COUNT(*)
   )
   AND NOT EXISTS (
     SELECT 1 FROM article_size_migration_diagnostics d
     WHERE d.article = pv.article AND d.size = pv.size AND d.field_name = 'selling_price'
   );

INSERT INTO article_size_migration_diagnostics (id, article, size, field_name, details_json, created_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))),
  pv.article,
  pv.size,
  'relationship_metadata',
  json_object(
    'productGroupIds', group_concat(DISTINCT COALESCE(pv.product_group_id, 'NULL')),
    'articleSeriesIds', group_concat(DISTINCT COALESCE(pv.article_series_id, 'NULL'))
  ),
  CURRENT_TIMESTAMP
FROM product_variants pv
WHERE pv.deleted_at IS NULL
GROUP BY pv.article, pv.size
HAVING (
     COUNT(DISTINCT CASE WHEN pv.product_group_id IS NOT NULL THEN pv.product_group_id END) > 1
     OR COUNT(pv.product_group_id) <> COUNT(*)
     OR COUNT(DISTINCT CASE WHEN pv.article_series_id IS NOT NULL THEN pv.article_series_id END) > 1
     OR COUNT(pv.article_series_id) <> COUNT(*)
   )
   AND NOT EXISTS (
     SELECT 1 FROM article_size_migration_diagnostics d
     WHERE d.article = pv.article AND d.size = pv.size AND d.field_name = 'relationship_metadata'
   );

UPDATE article_sizes
SET selling_price = NULL
WHERE EXISTS (
  SELECT 1 FROM product_variants pv
  WHERE pv.article_size_id = article_sizes.id
    AND pv.deleted_at IS NULL
    AND pv.selling_price IS NULL
)
AND EXISTS (
  SELECT 1 FROM product_variants pv
  WHERE pv.article_size_id = article_sizes.id
    AND pv.deleted_at IS NULL
    AND pv.selling_price IS NOT NULL
);

UPDATE article_sizes
SET cost_price = NULL
WHERE EXISTS (
  SELECT 1 FROM product_variants pv
  WHERE pv.article_size_id = article_sizes.id AND pv.deleted_at IS NULL AND pv.cost_price IS NULL
)
AND EXISTS (
  SELECT 1 FROM product_variants pv
  WHERE pv.article_size_id = article_sizes.id AND pv.deleted_at IS NULL AND pv.cost_price IS NOT NULL
);

UPDATE article_sizes
SET main_group_id = NULL
WHERE EXISTS (
  SELECT 1 FROM product_variants pv
  WHERE pv.article_size_id = article_sizes.id AND pv.deleted_at IS NULL AND pv.main_group_id IS NULL
)
AND EXISTS (
  SELECT 1 FROM product_variants pv
  WHERE pv.article_size_id = article_sizes.id AND pv.deleted_at IS NULL AND pv.main_group_id IS NOT NULL
);

UPDATE article_sizes
SET product_group_id = NULL
WHERE EXISTS (
  SELECT 1 FROM product_variants pv
  WHERE pv.article_size_id = article_sizes.id AND pv.deleted_at IS NULL AND pv.product_group_id IS NULL
)
AND EXISTS (
  SELECT 1 FROM product_variants pv
  WHERE pv.article_size_id = article_sizes.id AND pv.deleted_at IS NULL AND pv.product_group_id IS NOT NULL
);

UPDATE article_sizes
SET article_series_id = NULL
WHERE EXISTS (
  SELECT 1 FROM product_variants pv
  WHERE pv.article_size_id = article_sizes.id AND pv.deleted_at IS NULL AND pv.article_series_id IS NULL
)
AND EXISTS (
  SELECT 1 FROM product_variants pv
  WHERE pv.article_size_id = article_sizes.id AND pv.deleted_at IS NULL AND pv.article_series_id IS NOT NULL
);