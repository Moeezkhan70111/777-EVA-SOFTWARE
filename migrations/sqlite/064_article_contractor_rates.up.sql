-- The STANDARD contractor rates of a product, beside its prices.
--
--   article_sizes   SK6 7/10    sale 650.00   cost 600.00
--                               machine 45.00   packing 18.00   printing 12.00   per DOZEN
--
-- Migration 063 put contractor pricing on a machine PROGRAM: what one day's work was agreed at.
-- This is the other half the owner asked for (2026-10-11): the rate a product is NORMALLY paid
-- at, set when the product is made, exactly as its sale price is.
--
-- The relationship between the two is the same one a sale voucher has with a selling price:
--
--   article_sizes.*_rate_paisa                 the standard, master data, changes when the deal
--                                              with the contractors changes
--   machine_program_article_rates.*_rate_paisa what THIS program's work was agreed at, defaulted
--                                              from the product and then owned by the program
--
-- A program keeps the rates it was made with, so changing a product's standard rate never
-- rewrites a day already priced -- the same reason a sale voucher keeps the rate it was billed at.
--
-- WHY ON article_sizes AND NOT ON product_variants: the price lives on the ArticleSize because
-- colour variants share it (migration 031), and a machine program run points at an
-- article_size_id. A carton's colour has no bearing on what moulding a dozen is paid, so there is
-- nothing to copy onto the variants and therefore nothing that can fall out of sync.
--
-- NULL MEANS NOT SET, and is not 0. A product nobody has priced is unpriced -- the program screen
-- says "Not priced" in words rather than showing it as free work -- while an explicit 0 means
-- that job is not paid for this article (printing on a plain slipper). Every reader keeps the two
-- apart, so the columns are nullable with no default.
--
-- Money is integer paisa (R15). 45.00 per dozen is 4500. No REAL siblings: these columns are new.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE article_sizes ADD COLUMN machine_rate_paisa INTEGER;
ALTER TABLE article_sizes ADD COLUMN packing_rate_paisa INTEGER;
ALTER TABLE article_sizes ADD COLUMN printing_rate_paisa INTEGER;
