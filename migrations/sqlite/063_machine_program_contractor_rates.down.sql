-- Takes contractor pricing back off machine programs.
--
-- Only rates are stored here, and nothing else reads them: no quantity, status or balance
-- depends on this table, and no amount was ever posted anywhere from it. Dropping it loses what
-- each article's work was priced at, and nothing else -- every program, run, upper line and
-- issued packet is untouched.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

DROP INDEX IF EXISTS idx_machine_program_article_rates_article;

DROP TABLE IF EXISTS machine_program_article_rates;
