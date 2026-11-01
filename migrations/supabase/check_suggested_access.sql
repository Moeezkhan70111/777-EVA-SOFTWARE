-- NOT A MIGRATION. TEST PROJECT ONLY. Run whole through execute_sql or the SQL editor, after 023.
-- Functional check of 023 on TEST. Leaves nothing behind: the block ends by raising, so every
-- write in it is rolled back. Success is the error message 'SUGGESTED_ACCESS_CHECK_PASSED ...'.
do $$
declare
  template text := (select device_id from public.device_accounts where device_id is not null order by enrolled_at limit 1);
  device_auth uuid := gen_random_uuid();
  r jsonb;
  admin_token text;
  refused boolean;
begin
  if template is null then raise exception 'SETUP: no enrolled device on this project to copy'; end if;
  insert into public.workstations
  select (jsonb_populate_record(null::public.workstations, to_jsonb(w)
          || jsonb_build_object('id', 'ws-sugg-check', 'device_id', 'sugg-check', 'workstation_code', 'SUGG-CHECK', 'name', 'sugg-check'))).*
    from public.workstations w where w.device_id = template;
  insert into public.device_accounts
  select (jsonb_populate_record(null::public.device_accounts, to_jsonb(d)
          || jsonb_build_object('auth_user_id', device_auth, 'device_id', 'sugg-check', 'workstation_id', 'ws-sugg-check',
                                'label', 'sugg-check', 'claim_holder', null, 'claim_epoch', 0))).*
    from public.device_accounts d where d.device_id = template;
  perform set_config('request.jwt.claim.sub', device_auth::text, true);

  -- Setup: an approved admin.
  r := public.sign_up('sugg-admin@check.test', 'admin1234', 'Admin');
  admin_token := r->>'token';
  update public.people set status = 'APPROVED', is_admin = true, revision = revision + 1 where lower(email) = 'sugg-admin@check.test';

  -- 1. A claim carries what the account had: kept while PENDING, in the snapshot and the log.
  r := public.claim_existing_account('sugg-munshi', 'munshi@check.test', 'munshi123', 'Munshi',
         '{"roleCode": "munshi", "extraPermissions": ["logs", "stock"], "jobRole": " Munshi ", "authorityLevel": 20}'::jsonb);
  if r->'person'->>'status' is distinct from 'PENDING' then raise exception 'STEP 1: claim: %', r; end if;
  if r->'person'->'suggestedAccess' is distinct from
     '{"roleCode": "munshi", "extraPermissions": ["logs", "stock"], "jobRole": "Munshi", "authorityLevel": 20}'::jsonb then
    raise exception 'STEP 1: suggestion not kept as sent: %', r->'person'->'suggestedAccess';
  end if;
  if not exists (select 1 from public.sync_event_log
                  where aggregate_type = 'PERSON' and aggregate_id = 'sugg-munshi' and payload->'suggestedAccess'->>'roleCode' = 'munshi') then
    raise exception 'STEP 1: the suggestion did not reach the log';
  end if;

  -- 2. A suggestion that is not one is dropped; the claim itself still goes through.
  r := public.claim_existing_account('sugg-odd', 'odd@check.test', 'oddpass12', 'Odd',
         '{"roleCode": "Not A Code!", "extraPermissions": [], "jobRole": "", "authorityLevel": 10}'::jsonb);
  if r->'person'->>'status' is distinct from 'PENDING' or jsonb_typeof(r->'person'->'suggestedAccess') <> 'null' then
    raise exception 'STEP 2: malformed suggestion: %', r;
  end if;
  r := public.claim_existing_account('sugg-none', 'none@check.test', 'nonepass1', 'None');
  if jsonb_typeof(r->'person'->'suggestedAccess') <> 'null' then raise exception 'STEP 2: no suggestion: %', r; end if;

  -- 3. A suggestion is never access: approving with something else gives exactly that, and clears it.
  r := public.admin_set_access(admin_token, 'sugg-munshi', 'APPROVED', false, null, array['dashboard'], 'Helper', 15);
  if r->'person'->>'status' <> 'APPROVED' or r->'person'->'extraPermissions' <> '["dashboard"]'::jsonb then
    raise exception 'STEP 3: approval: %', r;
  end if;
  if jsonb_typeof(r->'person'->'suggestedAccess') <> 'null'
     or (select suggested_access from public.people where id = 'sugg-munshi') is not null then
    raise exception 'STEP 3: the suggestion outlived the decision: %', r;
  end if;

  -- 4. A sign-up has nothing to suggest.
  r := public.sign_up('fresh@check.test', 'freshpass1', 'Fresh');
  if jsonb_typeof(r->'person'->'suggestedAccess') <> 'null' then raise exception 'STEP 4: sign-up: %', r; end if;

  -- 5. No client calls the reader of suggestions directly.
  set local role authenticated;
  refused := false;
  begin
    perform public.account_suggestion('{}'::jsonb);
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'STEP 5: a client called account_suggestion'; end if;
  reset role;

  raise exception 'SUGGESTED_ACCESS_CHECK_PASSED: all 5 steps (rolled back, nothing kept)';
end;
$$;
