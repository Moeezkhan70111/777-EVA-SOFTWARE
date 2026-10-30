-- Removes the arrival time from the tables the sync applier writes.
--
-- Nothing decides anything from replicated_at, so dropping it breaks no rule -- but the record of
-- which rows came from another computer, and when, is lost for good. created_at is untouched
-- either way: it was always the origin's.
--
-- Nothing executes this file: the runner reads *.up.sql only, and the application has no
-- rollback path. It exists so the forward migration can be read against its inverse.
--
-- (No semicolons in comments.)

ALTER TABLE production_events DROP COLUMN replicated_at;
ALTER TABLE qr_master DROP COLUMN replicated_at;
ALTER TABLE product_variants DROP COLUMN replicated_at;
