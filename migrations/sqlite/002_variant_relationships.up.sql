ALTER TABLE product_variants ADD COLUMN main_group_id TEXT;
ALTER TABLE product_variants ADD COLUMN product_group_id TEXT;
ALTER TABLE product_variants ADD COLUMN article_series_id TEXT;

CREATE INDEX IF NOT EXISTS idx_product_variants_product_group_id ON product_variants(product_group_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_article_series_id ON product_variants(article_series_id);