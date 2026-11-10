-- NOT A MIGRATION. TEST PROJECT ONLY. Run whole through execute_sql or the SQL editor.
-- Functional check of 029 (the colour list as a leased record) on TEST, after 011, 013, 018 and 028. It runs
-- 029's own two inserts INSIDE this block, so it works whether or not 029 has been applied, and leaves nothing
-- behind: the block ends by raising, so the temporary device, its claim, the leases, 029's rows, the records and
-- the log rows are all rolled back. Success is the error message 'COLOR_TRANSLATIONS_CHECK_PASSED ...'.
do $$
declare
  b text := 'ct-check-device';
  uid uuid := gen_random_uuid();
  holder uuid := gen_random_uuid();
  e bigint;
  r jsonb;
  outcomes text;
  black jsonb := jsonb_build_object('aggregate_type', 'COLOR_TRANSLATION', 'record_id', 'color:black', 'revision', 1, 'deleted', false,
    'body', jsonb_build_object('row', jsonb_build_object('id', 'color:black', 'english_key', 'black', 'english_name', 'Black',
      'urdu_name', 'سیاہ', 'created_at', '2026-11-10T00:00:00.000Z', 'updated_at', '2026-11-10T00:00:00.000Z'), 'children', '{}'::jsonb));
  seen int;
begin
  insert into public.workstations
  select (jsonb_populate_record(null::public.workstations, to_jsonb(w)
          || jsonb_build_object('id', 'ws-ct-check', 'device_id', b, 'workstation_code', 'CT-CHECK', 'name', 'ct check'))).*
    from public.workstations w where w.device_id = 'desktop-main';
  insert into public.device_accounts
  select (jsonb_populate_record(null::public.device_accounts, to_jsonb(d)
          || jsonb_build_object('auth_user_id', uid, 'device_id', b, 'workstation_id', 'ws-ct-check',
                                'label', 'ct check', 'claim_holder', holder, 'claim_epoch', 1))).*
    from public.device_accounts d where d.device_id = 'desktop-main';
  insert into public.number_blocks (block, device_id, auth_user_id) values (996, b, uid);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', uid, 'role', 'authenticated')::text, true);
  e := (public.grant_domain_lease('MASTER_DATA', b, 'ct check')->>'epoch')::bigint;
  black := black || jsonb_build_object('lease_epoch', e);

  -- 0. Before 029 (when not yet applied): a colour is UNKNOWN_RECORD_TYPE, which a v0.5.1 client treats as a wait,
  --    while a PARTY in the same call still lands: nothing else is held up.
  if not exists (select 1 from public.leased_record_types where aggregate_type = 'COLOR_TRANSLATION') then
    r := public.push_leased_record(1, holder, jsonb_build_array(black,
      jsonb_build_object('aggregate_type', 'PARTY', 'record_id', 'party-ct-0', 'revision', 1, 'deleted', false, 'lease_epoch', e,
                         'body', jsonb_build_object('id', 'party-ct-0', 'party_name', 'Check'))));
    select string_agg(coalesce(x->>'reason', x->>'outcome'), ',') into outcomes from jsonb_array_elements(r->'results') x;
    if outcomes is distinct from 'UNKNOWN_RECORD_TYPE,INSERTED' then raise exception 'STEP 0: %', outcomes; end if;
  end if;

  -- 029, exactly as its file has it.
  insert into public.sync_aggregate_types (aggregate_type, factory_scoped, note) values
    ('COLOR_TRANSLATION', false, 'An English colour and its Urdu name: a leased record (029), master data.')
  on conflict (aggregate_type) do nothing;
  insert into public.leased_record_types (aggregate_type, lease_domain) values ('COLOR_TRANSLATION', 'MASTER_DATA')
  on conflict (aggregate_type) do nothing;

  -- 1. Under another domain's lease only: refused.
  perform public.grant_domain_lease('MASTER_DATA', 'desktop-main', 'ct check: someone else');
  perform public.grant_domain_lease('RAW_MATERIAL_STORE', b, 'ct check: store only');
  r := public.push_leased_record(1, holder, jsonb_build_array(black));
  if r->'results'->0->>'reason' is distinct from 'NOT_LEASE_HOLDER' then raise exception 'STEP 1: %', r; end if;
  e := (public.grant_domain_lease('MASTER_DATA', b, 'ct check')->>'epoch')::bigint;
  black := black || jsonb_build_object('lease_epoch', e);

  -- 2. First revision lands, logged as TYPE:id:revision, unscoped, Urdu exactly as sent.
  r := public.push_leased_record(1, holder, jsonb_build_array(black));
  if r->'results'->0->>'outcome' is distinct from 'INSERTED' then raise exception 'STEP 2: %', r; end if;
  if (select payload->'body'->'row'->>'urdu_name' from public.sync_event_log where dedupe_key = 'COLOR_TRANSLATION:color:black:1')
     is distinct from 'سیاہ' then raise exception 'STEP 2: Urdu not logged as sent'; end if;
  if (select factory_id from public.sync_event_log where dedupe_key = 'COLOR_TRANSLATION:color:black:1') is not null then
    raise exception 'STEP 2: colour log row is factory-scoped';
  end if;

  -- 3. Same revision same content DUPLICATE, other content REVISION_CONFLICT, newer UPDATED, older SUPERSEDED.
  r := public.push_leased_record(1, holder, jsonb_build_array(
    black,
    black || jsonb_build_object('body', jsonb_build_object('row', jsonb_build_object('id', 'color:black', 'urdu_name', 'کالا'), 'children', '{}'::jsonb)),
    black || jsonb_build_object('revision', 3, 'body', jsonb_build_object('row', jsonb_build_object('id', 'color:black', 'english_key', 'black', 'english_name', 'Black', 'urdu_name', 'کالا'), 'children', '{}'::jsonb)),
    black || jsonb_build_object('revision', 2)));
  select string_agg(coalesce(x->>'reason', x->>'outcome'), ',') into outcomes from jsonb_array_elements(r->'results') x;
  if outcomes is distinct from 'DUPLICATE,REVISION_CONFLICT,UPDATED,SUPERSEDED' then raise exception 'STEP 3: %', outcomes; end if;

  -- 4. A deletion is a revision with no body.
  r := public.push_leased_record(1, holder, jsonb_build_array(black || '{"revision": 4, "deleted": true}'));
  if r->'results'->0->>'outcome' is distinct from 'UPDATED' then raise exception 'STEP 4: %', r; end if;
  if (select payload->>'deleted' || ':' || coalesce(payload->>'body', 'null') from public.sync_event_log
       where dedupe_key = 'COLOR_TRANSLATION:color:black:4') <> 'true:null' then raise exception 'STEP 4: deletion not logged without a body'; end if;

  -- 5. Existing record types unchanged beside it: a PARTY and a WORK_SECTION land in the same call.
  r := public.push_leased_record(1, holder, jsonb_build_array(
    black || jsonb_build_object('record_id', 'color:teal', 'body', jsonb_build_object('row', jsonb_build_object('id', 'color:teal', 'english_key', 'teal', 'english_name', 'Teal', 'urdu_name', 'ٹیل'), 'children', '{}'::jsonb)),
    jsonb_build_object('aggregate_type', 'PARTY', 'record_id', 'party-ct-5', 'revision', 1, 'deleted', false, 'lease_epoch', e, 'body', jsonb_build_object('id', 'party-ct-5')),
    jsonb_build_object('aggregate_type', 'WORK_SECTION', 'record_id', 'ws-ct-5', 'revision', 1, 'deleted', false, 'lease_epoch', e, 'body', jsonb_build_object('id', 'ws-ct-5'))));
  select string_agg(coalesce(x->>'reason', x->>'outcome'), ',') into outcomes from jsonb_array_elements(r->'results') x;
  if outcomes is distinct from 'INSERTED,INSERTED,INSERTED' then raise exception 'STEP 5: %', outcomes; end if;

  -- 6. Taken over: the old holder's next colour revision is refused, and the record does not move.
  perform public.grant_domain_lease('MASTER_DATA', 'desktop-main', 'ct check: takeover');
  r := public.push_leased_record(1, holder, jsonb_build_array(black || '{"revision": 5}'));
  if r->'results'->0->>'reason' is distinct from 'NOT_LEASE_HOLDER' then raise exception 'STEP 6: %', r; end if;
  if (select revision from public.leased_records where record_id = 'color:black') <> 4 then raise exception 'STEP 6: record moved'; end if;

  -- 7. A device reads the colour rows through the log's own policy, as a reader (any version) pulls them.
  perform set_config('role', 'authenticated', true);
  select count(*) into seen from public.sync_event_log where aggregate_type = 'COLOR_TRANSLATION';
  perform set_config('role', 'postgres', true);
  if seen <> 4 then raise exception 'STEP 7: device sees % colour log rows, expected 4', seen; end if;

  -- 8. No client may write the type tables 029 adds rows to.
  if has_table_privilege('authenticated', 'public.leased_record_types', 'INSERT') or has_table_privilege('anon', 'public.leased_record_types', 'INSERT')
     or has_table_privilege('authenticated', 'public.sync_aggregate_types', 'INSERT') or has_table_privilege('anon', 'public.sync_aggregate_types', 'INSERT') then
    raise exception 'STEP 8: a client can write the type tables';
  end if;

  raise exception 'COLOR_TRANSLATIONS_CHECK_PASSED: all 9 steps (rolled back, nothing kept)';
end;
$$;
