-- NOT A MIGRATION. TEST PROJECT ONLY. Run whole through execute_sql or the SQL editor, after 021.
-- Functional check of 021 on TEST. Leaves nothing behind: the block ends by raising, so every
-- write in it is rolled back. Success is the error message 'PERMISSION_REQUESTS_CHECK_PASSED ...'.
-- Any other error names the failed step.
do $$
declare
  template text := (select device_id from public.device_accounts where device_id is not null order by enrolled_at limit 1);
  ids uuid[] := array[gen_random_uuid(), gen_random_uuid()];
  names text[] := array['perm-check-a', 'perm-check-b'];
  r jsonb;
  admin_token text;
  bob_token text;
  bob_id text;
  request_id text;
  refused boolean;
  i int;
begin
  if template is null then raise exception 'SETUP: no enrolled device on this project to copy'; end if;
  for i in 1..2 loop
    insert into public.workstations
    select (jsonb_populate_record(null::public.workstations, to_jsonb(w)
            || jsonb_build_object('id', 'ws-' || names[i], 'device_id', names[i], 'workstation_code', upper(names[i]), 'name', names[i]))).*
      from public.workstations w where w.device_id = template;
    insert into public.device_accounts
    select (jsonb_populate_record(null::public.device_accounts, to_jsonb(d)
            || jsonb_build_object('auth_user_id', ids[i], 'device_id', names[i], 'workstation_id', 'ws-' || names[i],
                                  'label', names[i], 'claim_holder', null, 'claim_epoch', 0))).*
      from public.device_accounts d where d.device_id = template;
  end loop;

  -- Setup: an admin on PC A, and Bob signed up on PC B.
  perform set_config('request.jwt.claim.sub', ids[1]::text, true);
  r := public.sign_up('perm-admin@check.test', 'admin1234', 'Admin');
  admin_token := r->>'token';
  update public.people set status = 'APPROVED', is_admin = true, revision = revision + 1 where lower(email) = 'perm-admin@check.test';
  perform set_config('request.jwt.claim.sub', ids[2]::text, true);
  r := public.sign_up('perm-bob@check.test', 'bobpass99', 'Bob');
  bob_token := r->>'token';
  bob_id := r->'person'->>'personId';

  -- 1. A PENDING person cannot ask for more.
  r := public.request_permission(bob_token, 'stock', 'need it');
  if r->>'reason' is distinct from 'ACCESS_NOT_APPROVED' then raise exception 'STEP 1: pending person asked: %', r; end if;

  -- 2. Once approved, Bob asks: PENDING, logged as revision 1. Asking again returns the same request.
  perform set_config('request.jwt.claim.sub', ids[1]::text, true);
  r := public.admin_set_access(admin_token, bob_id, 'APPROVED', false, null, array[]::text[], '', 10);
  if (r->>'ok')::boolean is distinct from true then raise exception 'SETUP: approving Bob: %', r; end if;
  perform set_config('request.jwt.claim.sub', ids[2]::text, true);
  r := public.request_permission(bob_token, 'stock', 'need it');
  if (r->>'ok')::boolean is distinct from true or r->'request'->>'status' <> 'PENDING' then raise exception 'STEP 2: request: %', r; end if;
  request_id := r->'request'->>'requestId';
  if not exists (select 1 from public.sync_event_log where aggregate_type = 'PERMISSION_REQUEST' and aggregate_id = request_id and payload->>'revision' = '1') then
    raise exception 'STEP 2: request not logged';
  end if;
  r := public.request_permission(bob_token, 'stock', 'again');
  if r->'request'->>'requestId' is distinct from request_id then raise exception 'STEP 2: a second pending request: %', r; end if;

  -- 3. A screen code that is not one is refused.
  r := public.request_permission(bob_token, 'Stock Page!', null);
  if r->>'reason' is distinct from 'PERMISSION_INVALID' then raise exception 'STEP 3: bad code: %', r; end if;

  -- 4. Bob cannot decide his own request.
  r := public.admin_review_permission_request(bob_token, request_id, 'APPROVED', null);
  if r->>'reason' is distinct from 'ADMIN_REQUIRED' then raise exception 'STEP 4: Bob approved himself: %', r; end if;

  -- 5. The admin approves: the request is decided and logged, and the screen reaches Bob's PERSON.
  perform set_config('request.jwt.claim.sub', ids[1]::text, true);
  r := public.admin_review_permission_request(admin_token, request_id, 'APPROVED', 'ok');
  if (r->>'ok')::boolean is distinct from true or r->'request'->>'status' <> 'APPROVED' then raise exception 'STEP 5: approval: %', r; end if;
  if not exists (select 1 from public.people where id = bob_id and 'stock' = any (extra_permissions)) then
    raise exception 'STEP 5: screen not granted';
  end if;
  if not exists (select 1 from public.sync_event_log
                  where aggregate_type = 'PERSON' and aggregate_id = bob_id and payload->'extraPermissions' ? 'stock') then
    raise exception 'STEP 5: the grant did not reach PERSON';
  end if;
  if not exists (select 1 from public.sync_event_log
                  where aggregate_type = 'PERMISSION_REQUEST' and aggregate_id = request_id and payload->>'status' = 'APPROVED') then
    raise exception 'STEP 5: the decision was not logged';
  end if;

  -- 6. A decided request cannot be decided again.
  r := public.admin_review_permission_request(admin_token, request_id, 'REJECTED', null);
  if r->>'reason' is distinct from 'REQUEST_NOT_PENDING' then raise exception 'STEP 6: decided twice: %', r; end if;

  -- 7. A request from someone who has since lost access can be declined, never approved.
  perform set_config('request.jwt.claim.sub', ids[2]::text, true);
  r := public.request_permission(bob_token, 'logs', null);
  request_id := r->'request'->>'requestId';
  perform set_config('request.jwt.claim.sub', ids[1]::text, true);
  r := public.admin_set_access(admin_token, bob_id, 'REVOKED', false, null, array['stock'], '', 10);
  r := public.admin_review_permission_request(admin_token, request_id, 'APPROVED', null);
  if r->>'reason' is distinct from 'ACCESS_NOT_APPROVED' then raise exception 'STEP 7: approved for a revoked person: %', r; end if;
  r := public.admin_review_permission_request(admin_token, request_id, 'REJECTED', 'access removed');
  if r->'request'->>'status' is distinct from 'REJECTED' then raise exception 'STEP 7: decline: %', r; end if;

  -- 8. A signed-in client reads no request.
  set local role authenticated;
  refused := false;
  begin
    perform 1 from public.account_permission_requests;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'STEP 8: a client read the requests'; end if;
  reset role;

  raise exception 'PERMISSION_REQUESTS_CHECK_PASSED: all 8 steps (rolled back, nothing kept)';
end;
$$;
