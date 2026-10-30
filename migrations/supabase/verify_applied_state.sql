-- VERIFY A CLOUD PROJECT'S APPLIED STATE. READ-ONLY.
--
-- Not a migration: it changes nothing, has no number, and must never be applied as one. Run it
-- whole in the Supabase SQL editor (or through the MCP execute_sql tool) against any project that
-- has had schema.sql and 002-016 applied. One row per check. Every row must say ok = true.
--
-- Updated for 009 (2026-10-25): the log's types are rows in sync_aggregate_types and the scope rule
-- is a trigger, so checks 2, 3, 17 and 20-21 describe that. A project still at 008 fails exactly
-- those, and nothing else.
--
-- Updated for 011 (2026-10-25): three lease tables (check 3 goes from 23 to 26), and checks 22-26
-- describe the write lease. When 011 was written, a project still at 010 failed exactly 3, 22-24
-- and 26. Check 25 passes there trivially, since there is nothing yet for anon to call (confirmed
-- on test, 2026-10-25).
--
-- Updated for 012 (2026-10-25): two raw-material mirrors (check 3 goes to 28), two more push RPCs
-- (11-12 count eight), and check 27 for their log triggers. A project at 011 fails exactly 3, 11
-- and 27. Check 12 passes there trivially, as 25 does above.
--
-- Updated for 013 (2026-10-25): two leased-record tables (check 3 goes to 30), push_leased_record
-- (11-12 count nine), eight master-data types in check 20, and checks 28-29. A project at 012
-- fails exactly 3, 11, 20, 28 and 29.
--
-- Updated for 014 (2026-10-25): device_sync_health (check 3 goes to 31, 7 gains its SELECT, 15 goes to
-- 11 policies), report_sync_health (11-12 count ten), and check 30, which proves the table is one
-- row per computer and can never become a log. A project at 013 fails exactly 3, 7, 11, 15 and 30.
--
-- Updated for 015 (2026-10-26): the stock-movement mirror (check 3 goes to 32), push_stock_event
-- (11-12 count eleven), STOCK_EVENT in check 20, and check 31 for its log trigger. A project at 014
-- fails exactly 3, 11, 20 and 31.
--
-- Updated for 016 (2026-10-27): the realtime doorbell (check 3 goes to 33, 7 gains its SELECT, 15 goes
-- to 12 policies), and check 32, which proves the doorbell is rung by the log and is the ONLY public
-- table published to Realtime -- never the log itself, whose rows carry whole payloads. A project at
-- 015 fails exactly 3, 7, 15 and 32.
--
-- Updated for 018 (2026-10-30): the number-block registry and its history (check 3 goes to 35), and
-- check 33: one claim_device, taking the block; every write refusing a computer that holds none; and
-- the owner-only move no client can call. A project at 017 fails exactly 3 and 33. (017 changes no
-- figure here.)
--
-- Updated 2026-10-31: check 34, after supabase/schema.sql was pasted into test a second time by
-- mistake. Re-running the baseline is quiet -- every table is "if not exists" -- but it puts back the
-- carton updated_at trigger 002 removed and unpins set_updated_at (check 14). Check 34 catches the
-- first, which nothing here looked at.
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
         ('push_qr_master'), ('push_production_produced'), ('push_product_variant'),
         ('push_raw_material_qr_batch'), ('push_raw_material_qr'), ('push_leased_record'),
         ('report_sync_health'), ('push_stock_event')
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

  -- 2. THE 005-AFTER-009 TRAP. Re-running 005 brings back its two-type factory CHECK, and every
  --    raw-material log insert after that is refused. 009 replaced it with a trigger.
  union all select 2, '005-after-009: the two-type factory_scope CHECK is gone', '0',
    (select count(*)::text from pg_constraint
     where conname = 'sync_event_log_factory_scope' and conrelid = to_regclass('public.sync_event_log'))

  union all select 3, 'tables in public', '35',
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

  union all select 7, 'authenticated: exactly SELECT on the 7 synchronised tables, device_sync_health and the doorbell',
    'device_sync_health:SELECT,factories:SELECT,operators:SELECT,product_variants:SELECT,production_events:SELECT,qr_master:SELECT,sync_event_log:SELECT,sync_log_doorbell:SELECT,workstations:SELECT',
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
  union all select 11, 'the eleven RPCs exist', '11',
    (select count(distinct p.proname)::text from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname in (select name from expected_rpcs))

  union all select 12, 'the eleven RPCs: executable by anon', '0',
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
  union all select 15, 'policies in public', '12',
    (select count(*)::text from pg_policies where schemaname = 'public')

  union all select 16, 'policies for any role other than authenticated', '0',
    (select count(*)::text from pg_policies
     where schemaname = 'public' and roles <> array['authenticated']::name[])

  -- 17-18. THE LOG: written by triggers, append-only, and cheap to read by position.
  union all select 17, 'log, immutability and scope triggers present', '4',
    (select count(*)::text from pg_trigger
     where not tgisinternal
       and tgname in ('trg_qr_master_log', 'trg_production_events_log', 'trg_sync_event_log_immutable', 'trg_sync_event_log_scope'))

  union all select 18, 'sync_event_log indexes (seq) and (factory_id, seq)', '2',
    (select count(*)::text from pg_indexes
     where schemaname = 'public' and tablename = 'sync_event_log'
       and indexname in ('idx_sync_event_log_seq', 'idx_sync_event_log_factory_seq'))

  -- 19. THE SEED. Every installation already uses exactly this id.
  union all select 19, 'factory-777 seeded', '1',
    (select count(*)::text from public.factories where id = 'factory-777')

  -- 20-21. THE LOG'S TYPES (009): exactly these, each scoped or global as decided, and no client
  --        able to read or change the list.
  --     Read through query_to_xml, so a project without the table (before 009) reports 'table
  --     missing' on this row instead of failing the whole script: it has to diagnose exactly those.
  union all select 20, 'sync_aggregate_types: each type and whether it is factory-scoped',
    'INVENTORY_CATEGORY:false,INVENTORY_ITEM:false,INVENTORY_UNIT:false,MACHINE:false,PARTY:false,PARTY_GROUP:false,PRODUCTION_PRODUCED:true,PRODUCT_VARIANT:false,QR_MASTER:false,RAW_MATERIAL_QR:false,RAW_MATERIAL_QR_BATCH:false,STOCK_EVENT:false,UNIT_LADDER_PRESET:false,WORK_SECTION:false',
    case
      when to_regclass('public.sync_aggregate_types') is null then 'table missing'
      else coalesce((xpath('/row/v/text()', query_to_xml(
        'select string_agg(aggregate_type || '':'' || factory_scoped::text, '','' order by aggregate_type collate "C") as v
           from public.sync_aggregate_types', false, true, '')))[1]::text, '')
    end

  union all select 21, 'sync_aggregate_types: privileges held by anon/authenticated/PUBLIC', '0',
    (select count(*)::text
     from pg_class c cross join lateral aclexplode(c.relacl) a
     where c.oid = to_regclass('public.sync_aggregate_types')
       and a.grantee in ('anon'::regrole, 'authenticated'::regrole, 0))

  -- 22-26. THE WRITE LEASE (011): the six domains, a device can read and release but never
  --        grant, and the history of who held what cannot be rewritten. The lease tables' grants
  --        are already covered by 5-7, which look at every table in public.
  union all select 22, 'lease_domains: the six single-writer domains',
    'ACCOUNTS,APPROVALS,MACHINE_PROGRAMS,MASTER_DATA,RAW_MATERIAL_STORE,SALES_DISPATCH',
    case
      when to_regclass('public.lease_domains') is null then 'table missing'
      else coalesce((xpath('/row/v/text()', query_to_xml(
        'select string_agg(domain, '','' order by domain collate "C") as v from public.lease_domains',
        false, true, '')))[1]::text, '')
    end

  union all select 23, 'the five lease functions exist', '5',
    (select count(distinct p.proname)::text from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('last_seq_written_by', 'lease_holds', 'current_leases', 'release_domain_lease', 'grant_domain_lease'))

  union all select 24, 'lease functions executable by authenticated', 'current_leases,release_domain_lease',
    coalesce((select string_agg(p.proname, ',' order by p.proname) from pg_proc p
              where p.pronamespace = 'public'::regnamespace
                and p.proname in ('last_seq_written_by', 'lease_holds', 'current_leases', 'release_domain_lease', 'grant_domain_lease')
                and has_function_privilege('authenticated', p.oid, 'EXECUTE')), '')

  union all select 25, 'lease functions executable by anon', '0',
    (select count(*)::text from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('last_seq_written_by', 'lease_holds', 'current_leases', 'release_domain_lease',
                         'grant_domain_lease', 'refuse_lease_log_change')
       and has_function_privilege('anon', p.oid, 'EXECUTE'))

  union all select 26, 'domain_lease_events: append-only trigger present', '1',
    (select count(*)::text from pg_trigger
     where not tgisinternal and tgname = 'trg_domain_lease_events_immutable')

  -- 27. RAW-MATERIAL IDENTITY (012): label runs and packets reach the log through their triggers.
  --     The mirrors' grants are covered by 5-7 and their RLS by 4.
  union all select 27, 'raw-material log triggers present', '2',
    (select count(*)::text from pg_trigger
     where not tgisinternal and tgname in ('trg_raw_material_qr_batches_log', 'trg_raw_material_qrs_log'))

  -- 28-29. LEASED RECORDS (013): every revision is logged, and each record type is under the lease
  --        it belongs to. The table grants are covered by 5-7 and RLS by 4.
  union all select 28, 'leased-record log trigger present', '1',
    (select count(*)::text from pg_trigger
     where not tgisinternal and tgname = 'trg_leased_records_log')

  union all select 29, 'leased_record_types: each type and its lease domain',
    'INVENTORY_CATEGORY:MASTER_DATA,INVENTORY_ITEM:MASTER_DATA,INVENTORY_UNIT:MASTER_DATA,MACHINE:MASTER_DATA,PARTY:MASTER_DATA,PARTY_GROUP:MASTER_DATA,UNIT_LADDER_PRESET:MASTER_DATA,WORK_SECTION:MASTER_DATA',
    case
      when to_regclass('public.leased_record_types') is null then 'table missing'
      else coalesce((xpath('/row/v/text()', query_to_xml(
        'select string_agg(aggregate_type || '':'' || lease_domain, '','' order by aggregate_type collate "C") as v
           from public.leased_record_types', false, true, '')))[1]::text, '')
    end

  -- 30. SYNC HEALTH IS ONE ROW PER COMPUTER (014): the only key is device_id and no column draws
  --     from a sequence, so a report can only overwrite that computer's row, never add another.
  union all select 30, 'device_sync_health: keyed by device_id alone, nothing sequence-fed', 'device_id|0',
    case
      when to_regclass('public.device_sync_health') is null then 'table missing'
      else (select string_agg(a.attname, ',' order by a.attnum)
              from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
             where i.indrelid = to_regclass('public.device_sync_health') and i.indisprimary)
        || '|' ||
           (select count(*)::text from pg_attrdef d
             where d.adrelid = to_regclass('public.device_sync_health')
               and pg_get_expr(d.adbin, d.adrelid) like 'nextval(%')
    end

  -- 31. STOCK MOVEMENTS (015): every movement reaches the log through its trigger. The mirror's
  --     grants are covered by 5-7 and its RLS by 4.
  union all select 31, 'stock-movement log trigger present', '1',
    (select count(*)::text from pg_trigger
     where not tgisinternal and tgname = 'trg_inventory_stock_events_log')

  -- 32. THE REALTIME DOORBELL (016): the log rings it, and it is the only public table Realtime
  --     publishes. Publishing the log would stream every event's whole payload to every computer.
  union all select 32, 'doorbell rung by the log, and the only public table published to Realtime', '1|sync_log_doorbell',
    (select count(*)::text from pg_trigger where not tgisinternal and tgname = 'trg_sync_event_log_doorbell')
      || '|' ||
    coalesce((select string_agg(tablename, ',' order by tablename) from pg_publication_tables
               where pubname = 'supabase_realtime' and schemaname = 'public'), '')

  -- 33. THE NUMBER-BLOCK REGISTRY (018): one claim_device, and it takes the block; every write
  --     refuses a computer holding none; and only the owner can move a block. Its tables' grants
  --     are covered by 5-7 and their RLS by 4.
  union all select 33, 'claim takes the number block, writes refuse a computer without one, moves are owner-only', '1|true|false',
    (select count(*)::text from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'claim_device'
       and pg_get_function_identity_arguments(p.oid) = 'p_device_id text, p_workstation_id text, p_app_version text, p_number_block integer')
      || '|' ||
    coalesce((select (position('NUMBER_BLOCK_NOT_REGISTERED' in p.prosrc) > 0)::text from pg_proc p
              where p.pronamespace = 'public'::regnamespace and p.proname = 'claim_is_current'), 'missing')
      || '|' ||
    coalesce((select has_function_privilege('authenticated', p.oid, 'EXECUTE')::text from pg_proc p
              where p.pronamespace = 'public'::regnamespace and p.proname = 'reassign_number_block'), 'missing')

  -- 34. THE BASELINE-AFTER-002 TRAP. Re-running supabase/schema.sql puts back the trigger 002 dropped,
  --     and the cloud starts overwriting each carton's updated_at with its own clock. Re-apply 002's
  --     one line (drop trigger if exists trg_qr_master_updated_at on public.qr_master) and 007's
  --     set_updated_at pin if this or check 14 fails.
  union all select 34, 'baseline-after-002: the cloud does not rewrite a carton''s updated_at', '0',
    (select count(*)::text from pg_trigger where not tgisinternal and tgname = 'trg_qr_master_updated_at')
)
select n, check_name, expected, actual, actual = expected as ok
from checks
order by n;
