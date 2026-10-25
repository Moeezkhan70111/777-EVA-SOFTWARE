-- Removes leased records: the push, the log trigger, the record table and the type list.
--
-- WHAT THIS COSTS. Every record's current revision in the cloud goes. The sync_event_log rows the
-- trigger wrote STAY (the log is append-only), so computers that applied them keep them, and the
-- eight types stay in sync_aggregate_types because those log rows refer to them. A computer still
-- pushing gets "function does not exist", which the drain reads as transient: its queue waits.
--
-- Run before 011's rollback, never after: the push calls lease_holds.
--
-- Paste whole in the SQL editor. Contains drop, which the MCP tools refuse.

begin;

drop function if exists public.push_leased_record(bigint, uuid, jsonb);
drop trigger if exists trg_leased_records_log on public.leased_records;
drop function if exists public.log_leased_record_revision();
drop table if exists public.leased_records;
drop table if exists public.leased_record_types;

commit;
