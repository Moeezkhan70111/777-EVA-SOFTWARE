-- Reverses 035. Any carton standing at the gate is put back to DISPATCHED, which is exactly
-- where it was before its return was recorded - its RETURNED event and its sale_returns row
-- are the history of what happened and are not rewritten, only dropped with the table.
DROP INDEX IF EXISTS idx_production_events_sale_return;
ALTER TABLE production_events DROP COLUMN sale_return_id;
DROP INDEX IF EXISTS idx_sale_returns_voucher;
DROP INDEX IF EXISTS idx_sale_returns_qr;
DROP INDEX IF EXISTS idx_sale_returns_party_date;
DROP INDEX IF EXISTS idx_sale_returns_dispatch_event_live;
DROP TABLE IF EXISTS sale_returns;
UPDATE qr_master SET current_status = 'DISPATCHED' WHERE current_status = 'ON_GATE';
