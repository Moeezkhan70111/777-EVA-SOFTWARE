-- Removes the doorbell: computers go back to pulling on their timer, every minute.
--
-- WHAT THIS COSTS. Nothing is lost. The doorbell holds only the last position rung and who rang it,
-- never an event. A computer still subscribed sees its channel close and keeps its timer pull.
--
-- Paste whole in the SQL editor. Contains drop, which the MCP tools refuse.

begin;

do $$
begin
  if exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sync_log_doorbell'
  ) then
    alter publication supabase_realtime drop table public.sync_log_doorbell;
  end if;
end;
$$;

drop trigger if exists trg_sync_event_log_doorbell on public.sync_event_log;
drop function if exists public.ring_sync_log_doorbell();
drop table if exists public.sync_log_doorbell;

commit;
