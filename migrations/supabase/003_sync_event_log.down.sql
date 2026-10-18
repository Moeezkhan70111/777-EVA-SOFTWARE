-- Removes the ordered log and the triggers that fill it.
--
-- Dropping the log discards the positions every computer's pull cursor points at. After this,
-- each computer would re-read from the beginning, which is safe only because applying an event
-- twice is a no-op -- but it means every computer re-walks the whole history.
--
-- The log itself holds no business data that is not also in qr_master and production_events, so
-- dropping it loses a position, not a record.

begin;

drop trigger if exists trg_sync_event_log_immutable on sync_event_log;
drop function if exists refuse_sync_log_change();

drop trigger if exists trg_production_events_log on production_events;
drop function if exists log_production_produced_insert();

drop trigger if exists trg_qr_master_log on qr_master;
drop function if exists log_qr_master_insert();

drop table if exists sync_event_log;

commit;
