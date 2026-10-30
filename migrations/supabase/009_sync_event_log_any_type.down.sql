-- Puts sync_event_log back on 003 and 005's two hard-wired types.
--
-- WRITTEN TO FAIL when it would lose information: if the log already holds a row of any type other
-- than QR_MASTER and PRODUCTION_PRODUCED, re-adding the old CHECK fails and the whole transaction
-- rolls back. The log is append-only, so such a row cannot be deleted to make room.
--
-- Reverse order of the up file: policy, trigger, constraints, table.

begin;

drop policy if exists device_reads_sync_event_log on public.sync_event_log;
create policy device_reads_sync_event_log on public.sync_event_log
for select to authenticated
using (
  public.is_enrolled_device()
  and (
    factory_id = public.current_factory_id()
    or (factory_id is null and aggregate_type = 'QR_MASTER')
  )
);

drop trigger if exists trg_sync_event_log_scope on public.sync_event_log;
drop function if exists public.enforce_sync_event_log_scope();

alter table public.sync_event_log drop constraint if exists sync_event_log_aggregate_type_fkey;
alter table public.sync_event_log
  add constraint sync_event_log_aggregate_type_check
  check (aggregate_type in ('QR_MASTER', 'PRODUCTION_PRODUCED'));
alter table public.sync_event_log drop constraint if exists sync_event_log_factory_scope;
alter table public.sync_event_log add constraint sync_event_log_factory_scope check (
  (aggregate_type = 'PRODUCTION_PRODUCED' and factory_id is not null)
  or (aggregate_type = 'QR_MASTER' and factory_id is null)
);

drop table if exists public.sync_aggregate_types;

commit;
