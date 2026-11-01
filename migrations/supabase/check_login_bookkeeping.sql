-- NOT A MIGRATION. TEST PROJECT ONLY. Run whole through execute_sql or the SQL editor, after 024.
-- Functional check of 024 on TEST. Leaves nothing behind: the block ends by raising, so every write
-- in it is rolled back. Success is 'LOGIN_BOOKKEEPING_CHECK_PASSED ...'.
do $$
declare
  template text := (select device_id from public.device_accounts where device_id is not null order by enrolled_at limit 1);
  device_user uuid := gen_random_uuid();
  r jsonb;
  refused boolean;
  person_id text;
begin
  if template is null then raise exception 'SETUP: no enrolled device on this project to copy'; end if;
  insert into public.workstations
  select (jsonb_populate_record(null::public.workstations, to_jsonb(w)
          || jsonb_build_object('id', 'ws-login-check', 'device_id', 'login-check', 'workstation_code', 'LOGIN-CHECK', 'name', 'login-check'))).*
    from public.workstations w where w.device_id = template;
  insert into public.device_accounts
  select (jsonb_populate_record(null::public.device_accounts, to_jsonb(d)
          || jsonb_build_object('auth_user_id', device_user, 'device_id', 'login-check', 'workstation_id', 'ws-login-check',
                                'label', 'login-check', 'claim_holder', null, 'claim_epoch', 0))).*
    from public.device_accounts d where d.device_id = template;
  perform set_config('request.jwt.claim.sub', device_user::text, true);

  -- 1. make_first_admin refuses a placeholder, with or without a computer, and names nobody.
  refused := false;
  begin
    perform public.make_first_admin('<your email>', 'login-check');
  exception when others then refused := sqlerrm like 'EMAIL_INVALID%';
  end;
  if not refused then raise exception 'STEP 1: a placeholder was taken as an email'; end if;
  refused := false;
  begin
    perform public.make_first_admin('<your email>');
  exception when others then refused := sqlerrm like 'EMAIL_INVALID%';
  end;
  if not refused then raise exception 'STEP 1: a placeholder without a computer was not refused as an email'; end if;
  if exists (select 1 from public.first_admin_designation where email = '<your email>') then
    raise exception 'STEP 1: the placeholder was named';
  end if;

  -- 2. A revoked person with the right password is refused, and NOT recorded as signed in. The
  --    wrong-password count still starts again.
  r := public.sign_up('login@check.test', 'login1234', 'Login Check');
  person_id := r->'person'->>'personId';
  if person_id is null then raise exception 'SETUP: sign-up failed: %', r; end if;
  update public.people set status = 'REVOKED', failed_attempts = 3 where id = person_id;
  r := public.verify_login('login@check.test', 'login1234');
  if r->>'reason' is distinct from 'ACCESS_REVOKED' then raise exception 'STEP 2: revoked answer: %', r; end if;
  if (select last_login_at from public.people where id = person_id) is not null then
    raise exception 'STEP 2: a refused sign-in was recorded as the last sign-in';
  end if;
  if (select failed_attempts from public.people where id = person_id) <> 0 then
    raise exception 'STEP 2: the right password did not start the wrong-password count again';
  end if;

  -- 3. The same for a rejected person.
  update public.people set status = 'REJECTED' where id = person_id;
  r := public.verify_login('login@check.test', 'login1234');
  if r->>'reason' is distinct from 'ACCESS_REJECTED' then raise exception 'STEP 3: rejected answer: %', r; end if;
  if (select last_login_at from public.people where id = person_id) is not null then
    raise exception 'STEP 3: a refused sign-in was recorded as the last sign-in';
  end if;

  -- 4. Let in: recorded.
  update public.people set status = 'APPROVED' where id = person_id;
  r := public.verify_login('login@check.test', 'login1234');
  if (r->>'ok')::boolean is not true then raise exception 'STEP 4: approved person refused: %', r; end if;
  if (select last_login_at from public.people where id = person_id) is null then
    raise exception 'STEP 4: a sign-in that was let in was not recorded';
  end if;

  raise exception 'LOGIN_BOOKKEEPING_CHECK_PASSED: all 4 steps';
end;
$$;
