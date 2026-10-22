-- Three gaps found by verifying the applied schema rather than trusting it (2026-10-22).
--
-- None of these is reachable through PostgREST today, so none blocks the sync pilot. All three
-- are cheap, and two of them contradict claims the earlier migrations make about themselves,
-- which is the real reason to close them: a header that overstates its own guarantees is worse
-- than one that admits a gap.
--
-- ── 1. TRUNCATE WAS NEVER REVOKED ──────────────────────────────────────────
--
-- 004 and 006 revoke privileges BY NAME: `revoke insert, update, delete`, `revoke select`,
-- `revoke all on function`. Supabase's default grants on a new table in `public` give
-- `anon` and `authenticated` the whole set, and the set includes TRUNCATE, REFERENCES and
-- TRIGGER. Naming four privileges left three behind on every table.
--
-- TRUNCATE is the one that matters. It is NOT subject to row level security -- policies filter
-- rows, and TRUNCATE does not read rows -- so no policy in 004 or 005 constrains it. A role
-- holding it can empty production_events outright.
--
-- 006's own header says: "With no insert privilege there is no second write path, so no future
-- policy, trigger or endpoint can accept a write that skipped the claim." TRUNCATE is a second
-- write path. It is not an INSERT, so the claim machinery never sees it.
--
-- WHY IT IS NOT AN EMERGENCY. PostgREST exposes no TRUNCATE verb, so there is no request a
-- client can send that reaches it, and `authenticated` is a role PostgREST assumes rather than
-- one anybody logs into. The exposure needs a second mistake -- a SECURITY INVOKER function that
-- truncates, or a direct connection as that role. This removes the first one so the second
-- cannot combine with it.
--
-- REFERENCES and TRIGGER go too: REFERENCES lets a role point a foreign key at these tables,
-- which can block deletes in the parent; TRIGGER lets it attach a trigger that runs on other
-- roles' writes. Neither is wanted, and neither was ever deliberately granted.
--
-- ── 2. THREE TRIGGER FUNCTIONS HAVE A MUTABLE search_path ──────────────────
--
-- Every function 003, 005 and 006 create pins `set search_path = ''` and qualifies every name.
-- These three were missed. All three are SECURITY INVOKER (verified: prosecdef = false), so they
-- run as the caller and the escalation risk a SECURITY DEFINER function would carry is absent --
-- which is why this is hygiene rather than a hole. Pinned anyway, so the rule is "every function
-- in this project pins it" with no exception a reader has to remember.
--
-- ── 3. ONE POLICY RE-EVALUATES auth.uid() PER ROW ──────────────────────────
--
-- `device_reads_own_enrolment` calls auth.uid() directly, so Postgres treats it as volatile and
-- re-runs it for every row considered. Wrapping it in a scalar subquery makes it run once.
--
-- device_accounts will hold five rows, so this is worth nothing in practice. It is here because
-- it is one line, and because the same pattern copied into a policy on production_events later
-- would matter a great deal.
--
-- NOT CHANGED, deliberately:
--   * The 8 "signed-in users can execute SECURITY DEFINER function" advisories. Those are the
--     claim and push RPCs, and a device MUST be able to call them -- that is the architecture
--     006 exists to create, not an oversight.
--   * The 14 "RLS enabled, no policy" advisories. Those tables deny everything on purpose:
--     nothing synchronises them, so no policy is the correct policy.
--   * public.rls_auto_enable(). Supabase's own event-trigger function, owned by postgres with
--     search_path already pinned. It returns `event_trigger`, so it cannot be invoked as an RPC
--     whatever EXECUTE says. Not ours to revoke.
--   * The unindexed foreign keys. They cover parent-side deletes, which this schema never does
--     (history is corrected with a new event, never by editing an old one).
--
-- (Paste whole into the Supabase SQL editor. Apply after 006.)

begin;

-- ── 1 ──

revoke truncate, references, trigger on
  factories, workstations, operators, product_variants,
  qr_master, production_events, sync_event_log,
  device_accounts, device_claim_events
from anon, authenticated;

-- Everything else in public, for the same reason: the tables nothing synchronises are also
-- carrying the default grant, and a table that denies every read should not permit an emptying.
revoke truncate, references, trigger on
  app_settings, audit_log, backup_history, devices,
  metrics_counters, metrics_timeseries, report_daily_summary,
  role_permissions, roles,
  stock_projection_by_location, stock_projection_by_variant,
  sync_outbox, system_health_snapshots
from anon, authenticated;

-- ── 2 ──

alter function public.set_updated_at() set search_path = '';
alter function public.refuse_sync_log_change() set search_path = '';
alter function public.refuse_claim_log_change() set search_path = '';

-- ── 3 ──
--
-- Recreated rather than altered: a policy's USING expression cannot be changed in place. The
-- predicate is identical apart from the scalar subquery.

drop policy if exists device_reads_own_enrolment on device_accounts;
create policy device_reads_own_enrolment on device_accounts
for select to authenticated
using (auth_user_id = (select auth.uid()));

commit;
