-- What a product's PACKING RATE is made of.
--
--   article_sizes                    SK6 7/10   packing_rate_paisa 15000   (150.00 per DOZEN)
--   article_size_packing_items       BOX 5000 . TAPE 3000 . POLY BAG 5000 . LABOUR 2000
--
-- The owner asked (2026-10-12) for the packing rate to be entered as named attributes that add
-- up to it, instead of one typed figure.
--
-- article_sizes.packing_rate_paisa stays THE packing rate (migration 064). It is what a machine
-- program copies and what every charge is computed from, so nothing that reads it changes. When a
-- product has attributes, the data layer stores their sum there in the same write. A product with
-- no attributes keeps a typed packing rate exactly as before.
--
-- The attributes are master data, like the rate itself: saving the product replaces its list.
-- A program already priced keeps its own copy of the rate, so changing them never rewrites a day.
--
-- Money is integer paisa (R15).
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS article_size_packing_items (
  id TEXT PRIMARY KEY,
  article_size_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  rate_paisa INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (article_size_id) REFERENCES article_sizes(id),
  CHECK (length(trim(name)) > 0),
  CHECK (rate_paisa >= 0)
);

CREATE INDEX IF NOT EXISTS idx_article_size_packing_items_article
  ON article_size_packing_items(article_size_id, position);
