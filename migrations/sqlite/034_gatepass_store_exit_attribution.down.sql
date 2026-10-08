DROP INDEX IF EXISTS idx_production_events_gatepass;
ALTER TABLE production_events DROP COLUMN gatepass_id;
