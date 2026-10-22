-- Puts back the leftover grants, the mutable search paths, and the per-row auth.uid() call.
--
-- THERE IS NO GOOD REASON TO RUN THIS. Reversing it re-grants TRUNCATE on production_events and
-- qr_master to every signed-in device -- a privilege row level security does not constrain -- and
-- re-opens the gap 006's header claims does not exist. It is written out only so the forward
-- migration's shape is reviewable against its reverse, which is the convention in this folder.
--
-- If a later migration needs one of these privileges, grant that one privilege on that one table
-- deliberately, rather than reversing this file wholesale.
--
-- Nothing executes this: Supabase migrations here are applied by hand, and only the .up.sql is
-- ever pasted.

begin;

grant truncate, references, trigger on
  factories, workstations, operators, product_variants,
  qr_master, production_events, sync_event_log,
  device_accounts, device_claim_events
to anon, authenticated;

grant truncate, references, trigger on
  app_settings, audit_log, backup_history, devices,
  metrics_counters, metrics_timeseries, report_daily_summary,
  role_permissions, roles,
  stock_projection_by_location, stock_projection_by_variant,
  sync_outbox, system_health_snapshots
to anon, authenticated;

alter function public.set_updated_at() reset search_path;
alter function public.refuse_sync_log_change() reset search_path;
alter function public.refuse_claim_log_change() reset search_path;

drop policy if exists device_reads_own_enrolment on device_accounts;
create policy device_reads_own_enrolment on device_accounts
for select to authenticated
using (auth_user_id = auth.uid());

commit;
