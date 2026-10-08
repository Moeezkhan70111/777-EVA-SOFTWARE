-- An article discount rule is about an article (all of its sizes, or one size), never about
-- one colour of it. The table was keyed by a product_variants id - one colour the Discount
-- Policy screen picked on the party's behalf - so a rule could not be saved for an article
-- that has no colour registered yet, and the resolver had to join back through that variant
-- to learn the article name it actually matches on. Rebuilt keyed by the article name, the
-- same technique as 030: create the new shape, copy the rows, drop the old table, rename.
-- Where two colours of one article carried the same rule for a party, the live and most
-- recently updated one is kept. (No semicolons in comments: the runner splits on them.)
CREATE TABLE party_article_discounts_new (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL,
  article TEXT NOT NULL,
  size_scope TEXT NOT NULL DEFAULT 'ALL_SIZES' CHECK (size_scope IN ('ALL_SIZES','SEPARATE_SIZES')),
  size TEXT,
  discount_per_pair_paisa INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(party_id, article, size_scope, size),
  FOREIGN KEY (party_id) REFERENCES parties(id)
);
INSERT OR IGNORE INTO party_article_discounts_new (id, party_id, article, size_scope, size, discount_per_pair_paisa, created_at, updated_at, deleted_at)
  SELECT pad.id, pad.party_id, pv.article, pad.size_scope, pad.size, pad.discount_per_pair_paisa, pad.created_at, pad.updated_at, pad.deleted_at
  FROM party_article_discounts pad
  JOIN product_variants pv ON pv.id = pad.article_id
  ORDER BY (pad.deleted_at IS NULL) DESC, pad.updated_at DESC;
DROP TABLE party_article_discounts;
ALTER TABLE party_article_discounts_new RENAME TO party_article_discounts;
CREATE INDEX IF NOT EXISTS idx_party_article_discounts_party_article ON party_article_discounts(party_id, article);
CREATE INDEX IF NOT EXISTS idx_party_article_discounts_party_size ON party_article_discounts(party_id, size_scope, size);
