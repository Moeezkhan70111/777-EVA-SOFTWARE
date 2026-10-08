-- Exact ownership for a DISPATCHED event: which dispatch session (and therefore which
-- voucher) caused it, and the QR's exact state immediately before the dispatch. Before this,
-- cancelling a voucher had to guess which events belonged to it by article + size + a
-- timestamp bound, which is not a unique key and could reverse a different voucher's scans.
--
-- All four columns are nullable: historical DISPATCHED events written before this migration
-- have no attribution and must never be assigned one retroactively (see deleteSaleVoucher in
-- packages/data/src/database/sales.ts) - No semicolons in comments, the migration runner
-- splits statements on them.
ALTER TABLE production_events ADD COLUMN dispatch_session_id TEXT;
ALTER TABLE production_events ADD COLUMN previous_status TEXT;
ALTER TABLE production_events ADD COLUMN previous_location_type TEXT;
ALTER TABLE production_events ADD COLUMN previous_location_id TEXT;
CREATE INDEX IF NOT EXISTS idx_production_events_dispatch_session ON production_events(dispatch_session_id) WHERE dispatch_session_id IS NOT NULL;
