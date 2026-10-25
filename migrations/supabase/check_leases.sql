-- NOT A MIGRATION. TEST PROJECT ONLY. Run whole through execute_sql or the SQL editor.
-- Functional check of 011 on TEST. Leaves nothing behind: the block ends by raising, so every
-- write in it -- the temporary second device, the grants, the lease events -- is rolled back.
-- Success is the error message 'LEASE_CHECK_PASSED ...'. Any other error names the failed step.
do $$
declare
  a text := 'desktop-main';
  b text := 'lease-test-device';
  r jsonb;
  e bigint;
  refused boolean;
begin
  -- A second, active, bound device, copied from the first so every not-null column is filled.
  insert into public.workstations
  select (jsonb_populate_record(null::public.workstations, to_jsonb(w)
          || jsonb_build_object('id', 'ws-lease-test', 'device_id', b, 'workstation_code', 'LEASE-TEST', 'name', 'lease test'))).*
    from public.workstations w where w.device_id = a;
  insert into public.device_accounts
  select (jsonb_populate_record(null::public.device_accounts, to_jsonb(d)
          || jsonb_build_object('auth_user_id', gen_random_uuid(), 'device_id', b, 'workstation_id', 'ws-lease-test',
                                'label', 'lease test', 'claim_holder', null, 'claim_epoch', 0))).*
    from public.device_accounts d where d.device_id = a;

  -- 1. Nobody holds it at first.
  if public.lease_holds('RAW_MATERIAL_STORE', a, 0) then raise exception 'STEP 1: unheld lease reported held'; end if;

  -- 2. Grant to A.
  r := public.grant_domain_lease('RAW_MATERIAL_STORE', a, 'check: A');
  e := (r->>'epoch')::bigint;
  if not public.lease_holds('RAW_MATERIAL_STORE', a, e) then raise exception 'STEP 2: holder refused %', r; end if;
  if public.lease_holds('RAW_MATERIAL_STORE', a, e - 1) then raise exception 'STEP 2: stale epoch accepted'; end if;
  if public.lease_holds('RAW_MATERIAL_STORE', b, e) then raise exception 'STEP 2: non-holder accepted'; end if;
  if public.lease_holds('MASTER_DATA', a, e) then raise exception 'STEP 2: lease leaked to another domain'; end if;

  -- 3. Granting to the holder again changes nothing.
  r := public.grant_domain_lease('RAW_MATERIAL_STORE', a, 'check: A again');
  if (r->>'unchanged')::boolean is distinct from true or (r->>'epoch')::bigint <> e then
    raise exception 'STEP 3: regrant to holder bumped the lease %', r;
  end if;

  -- 4. Takeover by B: A refused at once, recorded as TAKEN_OVER.
  r := public.grant_domain_lease('RAW_MATERIAL_STORE', b, 'check: B');
  if r->>'tookOverFrom' is distinct from a then raise exception 'STEP 4: takeover not reported %', r; end if;
  if public.lease_holds('RAW_MATERIAL_STORE', a, e) then raise exception 'STEP 4: old holder still accepted'; end if;
  if not public.lease_holds('RAW_MATERIAL_STORE', b, (r->>'epoch')::bigint) then raise exception 'STEP 4: new holder refused'; end if;

  -- 5. Back to A: A's first-tenure epoch stays refused.
  r := public.grant_domain_lease('RAW_MATERIAL_STORE', a, 'check: A back');
  if public.lease_holds('RAW_MATERIAL_STORE', a, e) then raise exception 'STEP 5: first-tenure epoch accepted after A-B-A'; end if;
  if not public.lease_holds('RAW_MATERIAL_STORE', a, (r->>'epoch')::bigint) then raise exception 'STEP 5: A refused under its new epoch'; end if;

  -- 6. The record: GRANTED, TAKEN_OVER, TAKEN_OVER, in order, and it cannot be rewritten.
  if (select string_agg(event, ',' order by seq) from public.domain_lease_events where domain = 'RAW_MATERIAL_STORE')
     is distinct from 'GRANTED,TAKEN_OVER,TAKEN_OVER' then
    raise exception 'STEP 6: lease history wrong: %',
      (select string_agg(event, ',' order by seq) from public.domain_lease_events where domain = 'RAW_MATERIAL_STORE');
  end if;
  refused := false;
  begin
    update public.domain_lease_events set by_label = 'rewritten';
  exception when others then
    refused := sqlerrm = 'domain_lease_events is append-only';
  end;
  if not refused then raise exception 'STEP 6: lease history could be rewritten'; end if;

  -- 7. Only an active, bound device may be granted a lease.
  refused := false;
  begin
    perform public.grant_domain_lease('RAW_MATERIAL_STORE', 'no-such-device', 'check: nobody');
  exception when others then
    refused := sqlerrm like 'NOT_AN_ACTIVE_DEVICE%';
  end;
  if not refused then raise exception 'STEP 7: lease granted to a device that does not exist'; end if;

  -- 8. Called as a signed-in client, grant is refused and the read gives an unenrolled account nothing.
  set local role authenticated;
  refused := false;
  begin
    perform public.grant_domain_lease('RAW_MATERIAL_STORE', b, 'check: client');
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'STEP 8: a client could grant a lease'; end if;
  if exists (select 1 from public.current_leases()) then raise exception 'STEP 8: unenrolled caller read the leases'; end if;
  reset role;

  raise exception 'LEASE_CHECK_PASSED: all 8 steps (rolled back, nothing kept)';
end;
$$;
