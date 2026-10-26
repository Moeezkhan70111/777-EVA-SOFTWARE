-- NOT A MIGRATION. TEST PROJECT ONLY. Paste whole in the SQL editor of wpkrhgqsizjjdaztijwv.
--
-- Clears what the store PC replicates -- master records, stock movements, label runs and packets,
-- and their log events -- so a fresh copy of PC 2's database can be backfilled into test as if for
-- the first time (the rehearsal, step 3 of the path to production).
--
-- WHY IT IS NEEDED. The gate data and PC 2's data share record ids, and a fresh database numbers its
-- revisions from 1 again. Left in place, the gate test's revisions would make the cloud refuse
-- PC 2's as older (SUPERSEDED) or as conflicts, and the rehearsal would prove nothing.
--
-- WHAT IT LEAVES ALONE: carton identities and production scans (PC 2 syncs its cartons to test
-- today), every enrolment and claim, the lease grants and their history, and the type lists.
--
-- THE LOG IS APPEND-ONLY BY DESIGN (trg_sync_event_log_immutable). This disables that one trigger
-- for the length of this transaction only, and enables it again before committing. If anything
-- fails, the whole transaction rolls back and the trigger was never off.
--
-- Contains disable trigger and delete, which the MCP tools refuse -- and which must never be run
-- against production. The guard below stops it anywhere dev-gate-holder is not enrolled.
--
-- AFTERWARDS, on every PC that synced with test: its local copy of these records is now ahead of the
-- cloud. Start the rehearsal's reader from an empty database, and the holder from PC 2's copy.

begin;

do $$
begin
  if not exists (select 1 from public.device_accounts where device_id = 'dev-gate-holder') then
    raise exception 'NOT THE TEST PROJECT: dev-gate-holder is not enrolled here. Nothing was changed.';
  end if;
end;
$$;

alter table public.sync_event_log disable trigger trg_sync_event_log_immutable;

delete from public.sync_event_log
 where aggregate_type in (select aggregate_type from public.leased_record_types)
    or aggregate_type in ('STOCK_EVENT', 'RAW_MATERIAL_QR_BATCH', 'RAW_MATERIAL_QR');

alter table public.sync_event_log enable trigger trg_sync_event_log_immutable;

delete from public.leased_records;
delete from public.inventory_stock_events;
delete from public.raw_material_qrs;
delete from public.raw_material_qr_batches;
-- Each PC reports again on its next pass.
delete from public.device_sync_health;

commit;

-- What is left: only carton types in the log, nothing in the store's tables, and the guard back on.
select
  (select string_agg(aggregate_type || ':' || n, ', ' order by aggregate_type)
     from (select aggregate_type, count(*) as n from public.sync_event_log group by aggregate_type) t) as log_left,
  (select count(*) from public.leased_records) + (select count(*) from public.inventory_stock_events)
    + (select count(*) from public.raw_material_qrs) + (select count(*) from public.raw_material_qr_batches) as store_rows_left,
  (select tgenabled <> 'D' from pg_trigger where tgname = 'trg_sync_event_log_immutable') as log_guard_on;
