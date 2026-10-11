-- Takes the standard contractor rates back off products.
--
-- Only the DEFAULT is lost. Every machine program keeps its own rates
-- (machine_program_article_rates, migration 063), because a program owns what its work was agreed
-- at -- so rolling this back means new programs open with empty rate boxes again, and nothing
-- already priced changes.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE article_sizes DROP COLUMN printing_rate_paisa;

ALTER TABLE article_sizes DROP COLUMN packing_rate_paisa;

ALTER TABLE article_sizes DROP COLUMN machine_rate_paisa;
