-- NOT A MIGRATION. TEST PROJECT ONLY. Run whole through execute_sql or the SQL editor.
-- Functional check of 013 on TEST, after 011 and 013 are applied. Leaves nothing behind: the block
-- ends by raising, so the temporary device, its claim, the leases, the records and the log rows
-- are all rolled back. PC2's rows are only READ, to copy not-null columns. Success is the error
-- message 'LEASED_RECORDS_CHECK_PASSED ...'.
do $$
declare
  b text := 'lr-check-device';
  uid uuid := gen_random_uuid();
  holder uuid := gen_random_uuid();
  e bigint;
  r jsonb;
  party jsonb := jsonb_build_object('aggregate_type', 'PARTY', 'record_id', 'party-lr-check', 'revision', 1,
    'deleted', false, 'body', jsonb_build_object('id', 'party-lr-check', 'party_name', 'Check Supplier', 'party_type', 'SUPPLIER'));
  outcomes text;
begin
  insert into public.workstations
  select (jsonb_populate_record(null::public.workstations, to_jsonb(w)
          || jsonb_build_object('id', 'ws-lr-check', 'device_id', b, 'workstation_code', 'LR-CHECK', 'name', 'lr check'))).*
    from public.workstations w where w.device_id = 'desktop-main';
  insert into public.device_accounts
  select (jsonb_populate_record(null::public.device_accounts, to_jsonb(d)
          || jsonb_build_object('auth_user_id', uid, 'device_id', b, 'workstation_id', 'ws-lr-check',
                                'label', 'lr check', 'claim_holder', holder, 'claim_epoch', 1))).*
    from public.device_accounts d where d.device_id = 'desktop-main';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', uid, 'role', 'authenticated')::text, true);

  -- 1. Without the master-data lease: refused. Holding ANOTHER domain's lease does not help.
  e := (public.grant_domain_lease('RAW_MATERIAL_STORE', b, 'lr check: store only')->>'epoch')::bigint;
  r := public.push_leased_record(1, holder, jsonb_build_array(party || jsonb_build_object('lease_epoch', e)));
  if r->'results'->0->>'reason' is distinct from 'NOT_LEASE_HOLDER' then raise exception 'STEP 1: %', r; end if;

  e := (public.grant_domain_lease('MASTER_DATA', b, 'lr check')->>'epoch')::bigint;
  party := party || jsonb_build_object('lease_epoch', e);

  -- 2. First revision lands and is logged as TYPE:id:revision with the reader's envelope.
  r := public.push_leased_record(1, holder, jsonb_build_array(party));
  if r->'results'->0->>'outcome' is distinct from 'INSERTED' then raise exception 'STEP 2: %', r; end if;
  if (select payload from public.sync_event_log where dedupe_key = 'PARTY:party-lr-check:1')
     is distinct from jsonb_build_object('recordId', 'party-lr-check', 'revision', 1, 'deleted', false, 'body', party->'body') then
    raise exception 'STEP 2: log payload %', (select payload from public.sync_event_log where dedupe_key = 'PARTY:party-lr-check:1');
  end if;

  -- 3. Same revision: same content DUPLICATE, other content REVISION_CONFLICT. Newer: UPDATED.
  --    Older than the cloud's: SUPERSEDED, and the record stays at the newer revision.
  r := public.push_leased_record(1, holder, jsonb_build_array(
    party,
    party || jsonb_build_object('body', jsonb_build_object('id', 'party-lr-check', 'party_name', 'Changed')),
    party || jsonb_build_object('revision', 3, 'body', jsonb_build_object('id', 'party-lr-check', 'party_name', 'Rev 3')),
    party || jsonb_build_object('revision', 2, 'body', jsonb_build_object('id', 'party-lr-check', 'party_name', 'Rev 2'))));
  select string_agg(coalesce(x->>'reason', x->>'outcome'), ',') into outcomes from jsonb_array_elements(r->'results') x;
  if outcomes is distinct from 'DUPLICATE,REVISION_CONFLICT,UPDATED,SUPERSEDED' then raise exception 'STEP 3: %', r; end if;
  if (select revision || ':' || (body->>'party_name') from public.leased_records where record_id = 'party-lr-check') <> '3:Rev 3' then
    raise exception 'STEP 3: record is not at revision 3';
  end if;
  if (select string_agg(dedupe_key, ',' order by seq) from public.sync_event_log where aggregate_id = 'party-lr-check')
     is distinct from 'PARTY:party-lr-check:1,PARTY:party-lr-check:3' then
    raise exception 'STEP 3: log %', (select string_agg(dedupe_key, ',' order by seq) from public.sync_event_log where aggregate_id = 'party-lr-check');
  end if;

  -- 4. A deletion is a revision with no body, logged in order.
  r := public.push_leased_record(1, holder, jsonb_build_array(party || '{"revision": 4, "deleted": true, "body": {"ignored": true}}'));
  if r->'results'->0->>'outcome' is distinct from 'UPDATED' then raise exception 'STEP 4: %', r; end if;
  if (select payload->>'deleted' || ':' || coalesce(payload->>'body', 'null') from public.sync_event_log
       where dedupe_key = 'PARTY:party-lr-check:4') <> 'true:null' then
    raise exception 'STEP 4: deletion not logged without a body';
  end if;

  -- 5. Refusals per row, in one call, beside a row that lands.
  r := public.push_leased_record(1, holder, jsonb_build_array(
    party || '{"aggregate_type": "GATEPASS", "record_id": "gp-1"}',
    party || '{"record_id": "p-array", "body": [1, 2]}',
    (party - 'deleted') || '{"record_id": "p-no-deleted"}',
    party || jsonb_build_object('record_id', 'p-huge', 'body', jsonb_build_object('x', repeat('a', 300000))),
    party || jsonb_build_object('record_id', 'p-stale', 'lease_epoch', e - 1),
    jsonb_build_object('aggregate_type', 'WORK_SECTION', 'record_id', 'ws-check', 'revision', 1, 'deleted', false,
                       'lease_epoch', e, 'body', jsonb_build_object('id', 'ws-check', 'name', 'Check'))));
  select string_agg(x->>'record_id' || '=' || coalesce(x->>'reason', x->>'outcome'), ',') into outcomes from jsonb_array_elements(r->'results') x;
  if outcomes is distinct from
     'gp-1=UNKNOWN_RECORD_TYPE,p-array=PAYLOAD_INCOMPLETE,p-no-deleted=PAYLOAD_INCOMPLETE,p-huge=RECORD_TOO_LARGE,p-stale=NOT_LEASE_HOLDER,ws-check=INSERTED' then
    raise exception 'STEP 5: %', outcomes;
  end if;

  -- 6. Taken over: the old holder's next revision is refused, and nothing changes.
  perform public.grant_domain_lease('MASTER_DATA', 'desktop-main', 'lr check: takeover');
  r := public.push_leased_record(1, holder, jsonb_build_array(party || '{"revision": 5}'));
  if r->'results'->0->>'reason' is distinct from 'NOT_LEASE_HOLDER' then raise exception 'STEP 6: %', r; end if;
  if (select revision from public.leased_records where record_id = 'party-lr-check') <> 4 then raise exception 'STEP 6: record moved'; end if;

  raise exception 'LEASED_RECORDS_CHECK_PASSED: all 6 steps (rolled back, nothing kept)';
end;
$$;
