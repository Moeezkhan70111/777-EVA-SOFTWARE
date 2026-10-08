DROP INDEX IF EXISTS idx_production_events_dispatch_session;
ALTER TABLE production_events DROP COLUMN previous_location_id;
ALTER TABLE production_events DROP COLUMN previous_location_type;
ALTER TABLE production_events DROP COLUMN previous_status;
ALTER TABLE production_events DROP COLUMN dispatch_session_id;
