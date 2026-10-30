-- Forgets who holds each write lease, and the epochs leased work was queued under.
--
-- What it costs: leased rows still queued lose their epoch, so they wait for the backfill instead
-- of being sent (the drain never sends a leased row without one). The lease cache is refilled by
-- the next pass if 093 is applied again.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE sync_outbox DROP COLUMN lease_epoch;
DROP TABLE IF EXISTS sync_domain_leases;
