-- Back to a product_variants key: each rule is re-attached to one live colour of its article.
-- A rule whose article has no colour registered cannot be represented and is dropped.
CREATE TABLE party_article_discounts_old (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  size_scope TEXT NOT NULL DEFAULT 'ALL_SIZES' CHECK (size_scope IN ('ALL_SIZES','SEPARATE_SIZES')),
  size TEXT,
  discount_per_pair_paisa INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(party_id, article_id, size_scope, size),
  FOREIGN KEY (party_id) REFERENCES parties(id),
  FOREIGN KEY (article_id) REFERENCES product_variants(id)
);
INSERT OR IGNORE INTO party_article_discounts_old (id, party_id, article_id, size_scope, size, discount_per_pair_paisa, created_at, updated_at, deleted_at)
  SELECT pad.id, pad.party_id, pv.id, pad.size_scope, pad.size, pad.discount_per_pair_paisa, pad.created_at, pad.updated_at, pad.deleted_at
  FROM party_article_discounts pad
  JOIN product_variants pv ON pv.article = pad.article AND pv.deleted_at IS NULL
  GROUP BY pad.id;
DROP TABLE party_article_discounts;
ALTER TABLE party_article_discounts_old RENAME TO party_article_discounts;
CREATE INDEX IF NOT EXISTS idx_party_article_discounts_party_article ON party_article_discounts(party_id, article_id);
CREATE INDEX IF NOT EXISTS idx_party_article_discounts_party_size ON party_article_discounts(party_id, size_scope, size);
