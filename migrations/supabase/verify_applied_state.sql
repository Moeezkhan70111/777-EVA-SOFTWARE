-- VERIFY A CLOUD PROJECT'S APPLIED STATE. READ-ONLY.
--
-- Not a migration: it changes nothing, has no number, and must never be applied as one. Run it
-- whole in the Supabase SQL editor (or through the MCP execute_sql tool) against any project that
-- has had schema.sql and 002-008 applied. One row per check. Every row must say ok = true.
--
-- It turns docs/36 section 6a's verified state into something that can be re-run instead of
-- re-read. Run it after setting up a project, and again after ANY change to its schema or grants.
--
-- The expected figures are the test project's verified state of 2026-10-23 (22 tables, 10
-- policies, 6 RPCs, the grant surface). A later migration that legitimately changes one of them
-- must change it here in the same commit, or this file starts reporting a correct project as
-- wrong.

with
expected_rpcs(name) as (
  values ('claim_device'), ('claim_is_current'), ('heartbeat_device'),
         ('push_qr_master'), ('push_production_produced'), ('push_product_variant')
),
client_table_grants as (
  -- Direct table-level grants to the two client roles and to PUBLIC (grantee 0).
  select c.relname, a.grantee, a.privilege_type
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) a
  where n.nspname = 'public'
    and c.relkind in ('r', 'v', 'm', 'p')
    and a.grantee in ('anon'::regrole, 'authenticated'::regrole, 0)
),
checks(n, check_name, expected, actual) as (
  -- 1. THE 003-AFTER-005 TRAP. Re-running 003 after 005 silently reinstates a production log
  --    trigger with no factory_id, and the next scan is refused by the factory-scope constraint.
  select 1, '003-after-005: log_production_produced_insert carries the 005 body', 'true',
    coalesce((select bool_and(position('origin_device_id, factory_id' in p.prosrc) > 0)::text
              from pg_proc p
              where p.proname = 'log_production_produced_insert' and p.pronamespace = 'public'::regnamespace),
             'function missing')

  union all select 2, 'sync_event_log_factory_scope constraint present', '1',
    (select count(*)::text from pg_constraint
     where conname = 'sync_event_log_factory_scope' and conrelid = to_regclass('public.sync_event_log'))

  union all select 3, 'tables in public', '22',
    (select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r')

  union all select 4, 'tables in public WITHOUT row level security', '0',
    (select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity)

  -- 5-7. THE CLIENT GRANT SURFACE: the line docs/36 says to re-check after any cloud change.
  union all select 5, 'anon: table privileges anywhere in public', '0',
    (select count(*)::text from client_table_grants where grantee = 'anon'::regrole)

  union all select 6, 'PUBLIC: table privileges anywhere in public', '0',
    (select count(*)::text from client_table_grants where grantee = 0)

  union all select 7, 'authenticated: exactly SELECT on the 7 synchronised tables',
    'factories:SELECT,operators:SELECT,product_variants:SELECT,production_events:SELECT,qr_master:SELECT,sync_event_log:SELECT,workstations:SELECT',
    coalesce((select string_agg(relname || ':' || privilege_type, ',' order by relname, privilege_type)
              from client_table_grants where grantee = 'authenticated'::regrole), '')

  -- 8-9. DEVICE EVICTION. A device that could read the current claim could never be superseded.
  union all select 8, 'device_accounts: columns readable by authenticated', '11',
    (select count(*)::text
     from pg_attribute att
     cross join lateral aclexplode(att.attacl) a
     where att.attrelid = to_regclass('public.device_accounts')
       and a.grantee = 'authenticated'::regrole and a.privilege_type = 'SELECT')

  union all select 9, 'device_accounts: claim_epoch / claim_holder readable by authenticated', 'false',
    (select (has_column_privilege('authenticated', 'public.device_accounts', 'claim_epoch', 'SELECT')
          or has_column_privilege('authenticated', 'public.device_accounts', 'claim_holder', 'SELECT'))::text)

  union all select 10, 'sync_event_log sequence: privileges held by anon/authenticated', '0',
    (select count(*)::text
     from pg_class c cross join lateral aclexplode(c.relacl) a
     where c.oid = to_regclass('public.sync_event_log_seq_seq')
       and a.grantee in ('anon'::regrole, 'authenticated'::regrole))

  -- 11-12. THE WRITE PATH. The claim-checking RPCs are the only way in, and anon cannot call them.
  union all select 11, 'the six RPCs exist', '6',
    (select count(distinct p.proname)::text from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname in (select name from expected_rpcs))

  union all select 12, 'the six RPCs: executable by anon', '0',
    (select count(*)::text from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname in (select name from expected_rpcs)
       and has_function_privilege('anon', p.oid, 'EXECUTE'))

  -- 13-14. FUNCTION HYGIENE. rls_auto_enable is Supabase's own and is excluded by name.
  union all select 13, 'SECURITY DEFINER functions in public without a pinned search_path', '',
    coalesce((select string_agg(p.proname, ',' order by p.proname) from pg_proc p
              where p.pronamespace = 'public'::regnamespace and p.prosecdef
                and p.proname <> 'rls_auto_enable'
                and not coalesce(array_to_string(p.proconfig, ',') like '%search_path=%', false)), '')

  union all select 14, 'trigger functions pinned by 007', '3',
    (select count(*)::text from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('set_updated_at', 'refuse_sync_log_change', 'refuse_claim_log_change')
       and coalesce(array_to_string(p.proconfig, ',') like '%search_path=%', false))

  -- 15-16. POLICIES: every one for authenticated, none for anon.
  union all select 15, 'policies in public', '10',
    (select count(*)::text from pg_policies where schemaname = 'public')

  union all select 16, 'policies for any role other than authenticated', '0',
    (select count(*)::text from pg_policies
     where schemaname = 'public' and roles <> array['authenticated']::name[])

  -- 17-18. THE LOG: written by triggers, append-only, and cheap to read by position.
  union all select 17, 'log and immutability triggers present', '3',
    (select count(*)::text from pg_trigger
     where not tgisinternal
       and tgname in ('trg_qr_master_log', 'trg_production_events_log', 'trg_sync_event_log_immutable'))

  union all select 18, 'sync_event_log indexes (seq) and (factory_id, seq)', '2',
    (select count(*)::text from pg_indexes
     where schemaname = 'public' and tablename = 'sync_event_log'
       and indexname in ('idx_sync_event_log_seq', 'idx_sync_event_log_factory_seq'))

  -- 19. THE SEED. Every installation already uses exactly this id.
  union all select 19, 'factory-777 seeded', '1',
    (select count(*)::text from public.factories where id = 'factory-777')
)
select n, check_name, expected, actual, actual = expected as ok
from checks
order by n;
