-- A doorbell for the cloud log, so a reading computer pulls within seconds of a write instead of
-- waiting up to a minute for its timer (owner decision, 2026-10-27: realtime wake-up).
--
-- WHAT RINGS. Every insert into sync_event_log rings sync_log_doorbell: one row per scope (the
-- factory, or 'global' for unscoped events) holding the position, the device that wrote it, and when.
-- Computers subscribe to that row through Supabase Realtime and, on a ring, run their ordinary pull.
--
-- WHY A DOORBELL AND NOT THE LOG ITSELF. Realtime sends each subscriber the whole changed row. On the
-- log that is every event's full payload -- during a backfill, thousands of master records with names
-- and costs, streamed to every computer a second time. The doorbell carries a position and a device
-- id. What changed is still read only through the pull, which validates every event (R25): the ring
-- says WHEN to look, never WHAT is there.
--
-- ONCE PER TRANSACTION. A push inserts up to a hundred log rows in one transaction. The trigger rings
-- on the first and skips the rest (a transaction-local flag), so one push is one ring, not a hundred.
-- Realtime delivers the change at commit, when every row of the push is already readable.
--
-- NEVER THE ONLY WAY. A ring that is missed -- the socket down, a burst throttled -- costs nothing: the
-- timer pull still runs every minute, and a computer pulls once on every reconnect.
--
-- Requires 003 (the log), 004 (is_enrolled_device, current_factory_id). Paste whole in the SQL editor,
-- TEST project first. Contains revoke, which the MCP tools refuse.

begin;

create table if not exists public.sync_log_doorbell (
  scope text primary key,
  factory_id text references public.factories (id),
  last_seq bigint not null,
  last_origin_device_id text,
  rung_at timestamptz not null default now(),
  check ((factory_id is null) = (scope = 'global')),
  check (factory_id is null or scope = factory_id)
);
alter table public.sync_log_doorbell enable row level security;
revoke all on table public.sync_log_doorbell from public, anon, authenticated;
grant select on table public.sync_log_doorbell to authenticated;

drop policy if exists device_reads_sync_log_doorbell on public.sync_log_doorbell;
create policy device_reads_sync_log_doorbell on public.sync_log_doorbell
for select to authenticated
using (public.is_enrolled_device() and (factory_id = public.current_factory_id() or factory_id is null));

create or replace function public.ring_sync_log_doorbell() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope text := coalesce(new.factory_id, 'global');
  v_rung text := coalesce(current_setting('erp.doorbell_rung', true), '');
begin
  -- This scope already rung in this transaction: the commit delivers it, with this row readable too.
  -- Kept per scope, so a transaction writing both a factory's events and global ones rings both.
  if position('|' || v_scope || '|' in v_rung) > 0 then
    return new;
  end if;
  perform set_config('erp.doorbell_rung', v_rung || '|' || v_scope || '|', true);
  insert into public.sync_log_doorbell (scope, factory_id, last_seq, last_origin_device_id, rung_at)
  values (v_scope, new.factory_id, new.seq, new.origin_device_id, now())
  on conflict (scope) do update set
    last_seq = greatest(public.sync_log_doorbell.last_seq, excluded.last_seq),
    last_origin_device_id = excluded.last_origin_device_id,
    rung_at = excluded.rung_at;
  return new;
end;
$$;

drop trigger if exists trg_sync_event_log_doorbell on public.sync_event_log;
create trigger trg_sync_event_log_doorbell
after insert on public.sync_event_log
for each row execute procedure public.ring_sync_log_doorbell();

revoke all on function public.ring_sync_log_doorbell() from public, anon, authenticated;

-- The doorbell, and only the doorbell, is published to Realtime.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sync_log_doorbell'
  ) then
    alter publication supabase_realtime add table public.sync_log_doorbell;
  end if;
end;
$$;

commit;
