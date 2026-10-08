CREATE TABLE IF NOT EXISTS article_sizes (
  id TEXT PRIMARY KEY,
  article TEXT NOT NULL,
  size TEXT NOT NULL,
  description TEXT,
  cost_price REAL,
  selling_price REAL,
  main_group_id TEXT,
  product_group_id TEXT,
  article_series_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT,
  UNIQUE(article, size),
  FOREIGN KEY (main_group_id) REFERENCES main_groups(id),
  FOREIGN KEY (product_group_id) REFERENCES product_groups(id),
  FOREIGN KEY (article_series_id) REFERENCES article_series(id)
);

CREATE TABLE IF NOT EXISTS article_size_migration_diagnostics (
  id TEXT PRIMARY KEY,
  article TEXT NOT NULL,
  size TEXT NOT NULL,
  field_name TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

ALTER TABLE product_variants ADD COLUMN description TEXT;
ALTER TABLE product_variants ADD COLUMN cost_price REAL;
ALTER TABLE product_variants ADD COLUMN selling_price REAL;
ALTER TABLE product_variants ADD COLUMN main_group_id TEXT;
ALTER TABLE product_variants ADD COLUMN product_group_id TEXT;
ALTER TABLE product_variants ADD COLUMN article_series_id TEXT;

ALTER TABLE product_variants ADD COLUMN article_size_id TEXT;

CREATE INDEX IF NOT EXISTS idx_article_sizes_article ON article_sizes(article);
CREATE INDEX IF NOT EXISTS idx_article_sizes_status ON article_sizes(status);
CREATE INDEX IF NOT EXISTS idx_product_variants_article_size_id ON product_variants(article_size_id);

INSERT INTO article_sizes (
  id, article, size, description, cost_price, selling_price,
  main_group_id, product_group_id, article_series_id, status,
  created_at, updated_at, deleted_at, deleted_by, delete_reason
)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))),
  pv.article,
  pv.size,
  CASE WHEN COUNT(DISTINCT COALESCE(pv.description, '')) = 1 THEN MIN(pv.description) END,
  CASE WHEN COUNT(pv.cost_price) = COUNT(*) AND COUNT(DISTINCT pv.cost_price) = 1 THEN MIN(pv.cost_price) END,
  CASE WHEN COUNT(pv.selling_price) = COUNT(*) AND COUNT(DISTINCT pv.selling_price) = 1 THEN MIN(pv.selling_price) END,
  CASE WHEN COUNT(pv.main_group_id) = COUNT(*) AND COUNT(DISTINCT pv.main_group_id) = 1 THEN MIN(pv.main_group_id) END,
  CASE WHEN COUNT(pv.product_group_id) = COUNT(*) AND COUNT(DISTINCT pv.product_group_id) = 1 THEN MIN(pv.product_group_id) END,
  CASE WHEN COUNT(pv.article_series_id) = COUNT(*) AND COUNT(DISTINCT pv.article_series_id) = 1 THEN MIN(pv.article_series_id) END,
  CASE WHEN MIN(pv.status) = 'ACTIVE' THEN 'ACTIVE' ELSE MIN(pv.status) END,
  MIN(pv.created_at),
  MAX(pv.updated_at),
  NULL, NULL, NULL
FROM product_variants pv
WHERE pv.deleted_at IS NULL
GROUP BY pv.article, pv.size;

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
HAVING COUNT(DISTINCT CASE WHEN pv.selling_price IS NOT NULL THEN pv.selling_price END) > 1
  OR COUNT(pv.selling_price) <> COUNT(*);

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
HAVING COUNT(DISTINCT CASE WHEN pv.product_group_id IS NOT NULL THEN pv.product_group_id END) > 1
  OR COUNT(pv.product_group_id) <> COUNT(*)
  OR COUNT(DISTINCT CASE WHEN pv.article_series_id IS NOT NULL THEN pv.article_series_id END) > 1
  OR COUNT(pv.article_series_id) <> COUNT(*);

UPDATE product_variants
SET article_size_id = (
  SELECT ass.id FROM article_sizes ass
  WHERE ass.article = product_variants.article
    AND ass.size = product_variants.size
    AND ass.deleted_at IS NULL
  LIMIT 1
)
WHERE deleted_at IS NULL;