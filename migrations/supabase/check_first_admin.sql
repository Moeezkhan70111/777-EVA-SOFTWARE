-- NOT A MIGRATION. TEST PROJECT ONLY. Run whole through execute_sql or the SQL editor, after 022.
-- Functional check of 022 on TEST. Leaves nothing behind: the block ends by raising, so every
-- write in it is rolled back -- including step 0, which sets aside any admin the project already
-- has so the "no admin yet" path can be exercised. Success is 'FIRST_ADMIN_CHECK_PASSED ...'.
do $$
declare
  template text := (select device_id from public.device_accounts where device_id is not null order by enrolled_at limit 1);
  ids uuid[] := array[gen_random_uuid(), gen_random_uuid()];
  names text[] := array['first-check-a', 'first-check-b'];
  r jsonb;
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

  -- 0. No approved admin, for the length of this check (rolled back with everything else).
  update public.people set is_admin = false, revision = revision + 1 where status = 'APPROVED' and is_admin;

  -- 1. Nobody has the email yet: naming needs the computer, and an enrolled one.
  refused := false;
  begin
    perform public.make_first_admin('owner@check.test');
  exception when others then refused := sqlerrm like 'PERSON_NOT_FOUND%';
  end;
  if not refused then raise exception 'STEP 1: named without a computer'; end if;
  refused := false;
  begin
    perform public.make_first_admin('owner@check.test', 'no-such-device');
  exception when others then refused := sqlerrm like 'DEVICE_NOT_ENROLLED%';
  end;
  if not refused then raise exception 'STEP 1: named at a computer that is not enrolled'; end if;

  -- 2. Named at A. The same email from B arrives PENDING, and is no admin.
  r := public.make_first_admin('owner@check.test', 'first-check-a');
  if r->>'named' is distinct from 'owner@check.test' then raise exception 'STEP 2: naming: %', r; end if;
  perform set_config('request.jwt.claim.sub', ids[2]::text, true);
  r := public.claim_existing_account('first-check-imposter', 'OWNER@check.test', 'imposter1', 'Imposter');
  if r->'person'->>'status' is distinct from 'PENDING' or (r->'person'->>'isAdmin')::boolean then
    raise exception 'STEP 2: a claim at the wrong computer became admin: %', r;
  end if;

  -- 3. Named again, for an email nobody has taken, still at A. Claimed at A: an approved admin at once.
  r := public.make_first_admin('boss@check.test', 'first-check-a');
  perform set_config('request.jwt.claim.sub', ids[1]::text, true);
  r := public.claim_existing_account('first-check-owner', 'boss@check.test', 'owner1234', 'Owner');
  if r->'person'->>'status' is distinct from 'APPROVED' or not (r->'person'->>'isAdmin')::boolean then
    raise exception 'STEP 3: the named claim was not an approved admin: %', r;
  end if;
  if exists (select 1 from public.first_admin_designation) then raise exception 'STEP 3: the designation survived its use'; end if;
  if not exists (select 1 from public.sync_event_log where aggregate_id = 'first-check-owner' and payload->>'isAdmin' = 'true') then
    raise exception 'STEP 3: the first admin did not reach the log';
  end if;

  -- 4. The token works for admin work at once.
  r := public.admin_save_role(r->>'token', null, 'First Check Role', null, 'ALWAYS_LOGGED_IN', array['stock']);
  if (r->>'ok')::boolean is distinct from true then raise exception 'STEP 4: the first admin could not act: %', r; end if;

  -- 5. Once an admin exists: no more naming, and a stale designation is not honoured.
  refused := false;
  begin
    perform public.make_first_admin('another@check.test', 'first-check-a');
  exception when others then refused := sqlerrm like 'ADMIN_EXISTS%';
  end;
  if not refused then raise exception 'STEP 5: named a second first admin'; end if;
  insert into public.first_admin_designation (email, device_id) values ('late@check.test', 'first-check-a');
  r := public.sign_up('late@check.test', 'latepass1', 'Late');
  if (r->'person'->>'isAdmin')::boolean then raise exception 'STEP 5: a stale designation made an admin: %', r; end if;

  -- 6. Someone who already exists is still made admin directly (020's path), when there is none.
  update public.people set is_admin = false, revision = revision + 1 where status = 'APPROVED' and is_admin;
  r := public.make_first_admin('late@check.test');
  if r->>'status' is distinct from 'APPROVED' or not (r->>'isAdmin')::boolean then raise exception 'STEP 6: existing person: %', r; end if;

  -- 7. No client reads the designation, or names anyone.
  set local role authenticated;
  refused := false;
  begin
    perform 1 from public.first_admin_designation;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'STEP 7: a client read the designation'; end if;
  refused := false;
  begin
    perform public.make_first_admin('x@check.test', 'first-check-a');
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'STEP 7: a client named a first admin'; end if;
  reset role;

  raise exception 'FIRST_ADMIN_CHECK_PASSED: all 7 steps (rolled back, nothing kept)';
end;
$$;
