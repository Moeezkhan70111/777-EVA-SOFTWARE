-- Removes only what 021 added. The backfilled legacy rows are left in place on purpose:
-- deleting them would drop registered identities that production history still depends on.
DROP INDEX IF EXISTS idx_barcodes_variant;
