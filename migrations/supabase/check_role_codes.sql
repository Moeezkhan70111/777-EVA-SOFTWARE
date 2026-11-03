-- NOT A MIGRATION. TEST PROJECT ONLY. Run whole through execute_sql or the SQL editor, after 025.
-- Regression check of 025: a new role never overwrites an existing one. Leaves nothing behind: the
-- block ends by raising, so every write in it is rolled back. Success is the error message
-- 'ROLE_CODES_CHECK_PASSED ...'. Any other error names the failed step. Before 025 it stops at step 3.
--
-- Set up exactly as check_accounts.sql: temporary devices copied from an existing enrolment (only
-- read), a person signed up on one, made an admin.
do $$
declare
  template text := (select device_id from public.device_accounts where device_id is not null order by enrolled_at limit 1);
  ids uuid[] := array[gen_random_uuid()];
  names text[] := array['role-check-a'];
  r jsonb;
  token text;
  before public.account_roles;
  after public.account_roles;
  logged int;
  audited int;
begin
  if template is null then raise exception 'SETUP: no enrolled device on this project to copy'; end if;
  insert into public.workstations
  select (jsonb_populate_record(null::public.workstations, to_jsonb(w)
          || jsonb_build_object('id', 'ws-' || names[1], 'device_id', names[1], 'workstation_code', upper(names[1]), 'name', names[1]))).*
    from public.workstations w where w.device_id = template;
  insert into public.device_accounts
  select (jsonb_populate_record(null::public.device_accounts, to_jsonb(d)
          || jsonb_build_object('auth_user_id', ids[1], 'device_id', names[1], 'workstation_id', 'ws-' || names[1],
                                'label', names[1], 'claim_holder', null, 'claim_epoch', 0))).*
    from public.device_accounts d where d.device_id = template;
  perform set_config('request.jwt.claim.sub', ids[1]::text, true);

  r := public.sign_up('roles@check.test', 'abcd1234', 'Role Admin');
  if (r->>'ok')::boolean is distinct from true then raise exception 'SETUP: sign-up refused: %', r; end if;
  token := r->>'token';
  if not exists (select 1 from public.people where status = 'APPROVED' and is_admin) then
    perform public.make_first_admin('roles@check.test');
  else
    update public.people set status = 'APPROVED', is_admin = true, revision = revision + 1
     where lower(email) = 'roles@check.test';
  end if;

  -- 1. A new role, made with no code, is coded from its name.
  r := public.admin_save_role(token, null, 'Check Billing Manager', 'bills', 'DAILY_LOGIN', array['dashboard', 'live-production']);
  if (r->>'ok')::boolean is distinct from true or r->'role'->>'roleCode' <> 'check-billing-manager' then
    raise exception 'STEP 1: role not created: %', r;
  end if;

  -- 2. Renamed by its code (an edit, unchanged by 025): same code, next revision.
  r := public.admin_save_role(token, 'check-billing-manager', 'Check Billing Desk', 'bills', 'DAILY_LOGIN', array['dashboard', 'live-production']);
  if (r->>'ok')::boolean is distinct from true or r->'role'->>'name' <> 'Check Billing Desk' or (r->'role'->>'revision')::int <> 2 then
    raise exception 'STEP 2: rename by code: %', r;
  end if;
  select * into before from public.account_roles where role_code = 'check-billing-manager';
  logged := (select count(*) from public.sync_event_log where aggregate_type = 'ACCOUNT_ROLE' and aggregate_id = 'check-billing-manager');
  audited := (select count(*) from public.account_events where subject = 'check-billing-manager');

  -- 3. THE BUG: a new role named as the old one was, with no code. Its name is free, its code is not.
  r := public.admin_save_role(token, null, 'Check Billing Manager', null, 'ALWAYS_LOGGED_IN', array['stock']);
  if r->>'reason' is distinct from 'ROLE_CODE_TAKEN' then raise exception 'STEP 3: rename-then-create was not refused: %', r; end if;

  -- 4. ...and the renamed role is exactly as it was: name, screens, policy, revision. Nothing logged or audited.
  select * into after from public.account_roles where role_code = 'check-billing-manager';
  if to_jsonb(after) is distinct from to_jsonb(before) then raise exception 'STEP 4: the existing role changed: % -> %', to_jsonb(before), to_jsonb(after); end if;
  if after.permissions is distinct from array['dashboard', 'live-production'] then raise exception 'STEP 4: screens changed: %', after.permissions; end if;
  if (select count(*) from public.sync_event_log where aggregate_type = 'ACCOUNT_ROLE' and aggregate_id = 'check-billing-manager') <> logged then
    raise exception 'STEP 4: the refused create reached the log';
  end if;
  if (select count(*) from public.account_events where subject = 'check-billing-manager') <> audited then
    raise exception 'STEP 4: the refused create was audited as a save';
  end if;

  -- 5. The same name made twice with no code is refused too (before 025 the second silently replaced the first).
  r := public.admin_save_role(token, null, 'Check Spare', null, 'ALWAYS_LOGGED_IN', array['dashboard']);
  if (r->>'ok')::boolean is distinct from true then raise exception 'STEP 5: first create: %', r; end if;
  r := public.admin_save_role(token, null, 'Check Spare', null, 'ALWAYS_LOGGED_IN', array['stock']);
  if r->>'reason' is distinct from 'ROLE_CODE_TAKEN' then raise exception 'STEP 5: second create: %', r; end if;
  if (select permissions from public.account_roles where role_code = 'check-spare') is distinct from array['dashboard'] then
    raise exception 'STEP 5: the first role''s screens changed';
  end if;

  -- 6. A DELETED role's code is still brought back by a create (unchanged by 025).
  r := public.admin_delete_role(token, 'check-spare');
  if (r->>'ok')::boolean is distinct from true then raise exception 'STEP 6: delete: %', r; end if;
  r := public.admin_save_role(token, null, 'Check Spare', null, 'ALWAYS_LOGGED_IN', array['stock']);
  if (r->>'ok')::boolean is distinct from true or (r->'role'->>'deleted')::boolean or (r->'role'->>'revision')::int <> 3 then
    raise exception 'STEP 6: a deleted role was not brought back: %', r;
  end if;

  -- 7. Edits by code still work after a refusal, and still refuse another role's name.
  r := public.admin_save_role(token, 'check-billing-manager', 'Check Billing Desk', 'bills', 'DAILY_LOGIN', array['dashboard']);
  if (r->>'ok')::boolean is distinct from true or (r->'role'->>'revision')::int <> 3 then raise exception 'STEP 7: edit by code: %', r; end if;
  r := public.admin_save_role(token, 'check-billing-manager', 'Check Spare', 'bills', 'DAILY_LOGIN', array['dashboard']);
  if r->>'reason' is distinct from 'ROLE_NAME_TAKEN' then raise exception 'STEP 7: rename onto a taken name: %', r; end if;

  raise exception 'ROLE_CODES_CHECK_PASSED: steps 1-7 (rolled back, nothing kept)';
end;
$$;
