-- Takes the packing attributes back off products.
--
-- Only the breakdown is lost. article_sizes.packing_rate_paisa still holds the sum they were
-- saved at, so every product keeps the same packing rate.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

DROP INDEX IF EXISTS idx_article_size_packing_items_article;

DROP TABLE IF EXISTS article_size_packing_items;
