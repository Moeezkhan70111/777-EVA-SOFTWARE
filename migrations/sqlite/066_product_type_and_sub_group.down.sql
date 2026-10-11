-- Takes the product type and the product sub group back off the Product Master.
--
-- The classification itself is lost, which is what rolling the feature back means. Every
-- product keeps its article, size, price, main group, product group and series: none of those
-- was touched.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

DROP INDEX IF EXISTS idx_article_sizes_product_sub_group;

DROP INDEX IF EXISTS idx_article_sizes_product_type;

ALTER TABLE product_variants DROP COLUMN product_sub_group_id;

ALTER TABLE product_variants DROP COLUMN product_type_id;

ALTER TABLE article_sizes DROP COLUMN product_sub_group_id;

ALTER TABLE article_sizes DROP COLUMN product_type_id;

DROP INDEX IF EXISTS idx_product_sub_groups_group;

DROP INDEX IF EXISTS idx_product_sub_groups_name;

DROP TABLE IF EXISTS product_sub_groups;

DROP INDEX IF EXISTS idx_product_types_name;

DROP TABLE IF EXISTS product_types;
