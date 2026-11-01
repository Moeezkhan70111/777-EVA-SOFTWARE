-- NOT A MIGRATION. TEST PROJECT ONLY. Run whole through execute_sql or the SQL editor, after 020.
-- Functional check of 020 on TEST. Leaves nothing behind: the block ends by raising, so every
-- write in it -- the temporary devices, the people, their tokens, roles, log rows -- is rolled back.
-- Success is the error message 'ACCOUNTS_CHECK_PASSED ...'. Any other error names the failed step.
--
-- The temporary devices copy an existing enrolment's row as a template, as check_number_blocks.sql
-- does. The template itself is only read.
do $$
declare
  template text := (select device_id from public.device_accounts where device_id is not null order by enrolled_at limit 1);
  ids uuid[] := array[gen_random_uuid(), gen_random_uuid()];
  names text[] := array['acct-check-a', 'acct-check-b'];
  stranger uuid := gen_random_uuid();
  r jsonb;
  alice_token text;
  bob_id text;
  bob_version int;
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

  -- 1. A computer that is not enrolled cannot sign anyone up.
  perform set_config('request.jwt.claim.sub', stranger::text, true);
  r := public.sign_up('stranger@check.test', 'abcd1234', 'Stranger');
  if r->>'reason' is distinct from 'NOT_ENROLLED' then raise exception 'STEP 1: unenrolled sign-up: %', r; end if;

  -- 2. An enrolled PC signs someone up: PENDING, with a token, logged as PERSON revision 1.
  perform set_config('request.jwt.claim.sub', ids[1]::text, true);
  r := public.sign_up('Alice@Check.test', 'abcd1234', 'Alice');
  if (r->>'ok')::boolean is distinct from true then raise exception 'STEP 2: sign-up refused: %', r; end if;
  if r->'person'->>'status' <> 'PENDING' then raise exception 'STEP 2: new person not PENDING: %', r; end if;
  if coalesce(r->>'token', '') = '' then raise exception 'STEP 2: no token'; end if;
  if not exists (select 1 from public.sync_event_log
                  where aggregate_type = 'PERSON' and aggregate_id = r->'person'->>'personId' and payload->>'revision' = '1') then
    raise exception 'STEP 2: PERSON revision 1 not logged';
  end if;
  alice_token := r->>'token';

  -- 3. Taken emails (any case), weak and over-long passwords are refused by code.
  r := public.sign_up('alice@check.TEST', 'abcd1234', 'Alice again');
  if r->>'reason' is distinct from 'EMAIL_TAKEN' then raise exception 'STEP 3: duplicate email: %', r; end if;
  r := public.sign_up('weak@check.test', 'abcdefgh', 'Weak');
  if r->>'reason' is distinct from 'PASSWORD_NEEDS_LETTER_AND_NUMBER' then raise exception 'STEP 3: weak password: %', r; end if;
  r := public.sign_up('long@check.test', repeat('a', 72) || '1', 'Long');
  if r->>'reason' is distinct from 'PASSWORD_TOO_LONG' then raise exception 'STEP 3: 73-byte password: %', r; end if;

  -- 4. Sign-in: a wrong password and an unknown email get the same answer.
  r := public.verify_login('alice@check.test', 'wrong1234');
  if r->>'reason' is distinct from 'WRONG_CREDENTIALS' then raise exception 'STEP 4: wrong password: %', r; end if;
  r := public.verify_login('nobody@check.test', 'abcd1234');
  if r->>'reason' is distinct from 'WRONG_CREDENTIALS' then raise exception 'STEP 4: unknown email: %', r; end if;
  r := public.verify_login('ALICE@check.test', 'abcd1234');
  if (r->>'ok')::boolean is distinct from true then raise exception 'STEP 4: right password refused: %', r; end if;

  -- 5. A PENDING person's token is not an admin's.
  r := public.admin_save_role(alice_token, null, 'Check Role', null, 'ALWAYS_LOGGED_IN', array['dashboard']);
  if r->>'reason' is distinct from 'ADMIN_REQUIRED' then raise exception 'STEP 5: pending person edited roles: %', r; end if;

  -- 6. The owner's first admin. On a project that already has one, Alice is promoted directly
  --    instead, and make_first_admin must then refuse.
  if not exists (select 1 from public.people where status = 'APPROVED' and is_admin) then
    perform public.make_first_admin('alice@check.test');
  else
    update public.people set status = 'APPROVED', is_admin = true, revision = revision + 1
     where lower(email) = 'alice@check.test';
  end if;
  refused := false;
  begin
    perform public.make_first_admin('alice@check.test');
  exception when others then refused := sqlerrm like 'ADMIN_EXISTS%';
  end;
  if not refused then raise exception 'STEP 6: a second first admin was made'; end if;

  -- 6b. Importing a PC's roles: all or nothing, and only into an empty catalogue. Its handler turns
  --     any failure into ROLES_INVALID, so the success path is what proves the body runs.
  if not exists (select 1 from public.account_roles) then
    r := public.admin_import_roles(alice_token, '[{"code": "imp-a", "name": "Imported A", "permissions": ["dashboard"]},
                                                  {"code": "BAD CODE", "name": "Imported B", "permissions": []}]'::jsonb);
    if r->>'reason' is distinct from 'ROLES_INVALID' then raise exception 'STEP 6b: bad import: %', r; end if;
    if exists (select 1 from public.account_roles) then raise exception 'STEP 6b: a failed import kept a role'; end if;
    r := public.admin_import_roles(alice_token, '[{"code": "imp-a", "name": "Imported A", "description": "a", "loginPolicy": "DAILY_LOGIN", "permissions": ["dashboard"]},
                                                  {"code": "imp-b", "name": "Imported B", "permissions": []}]'::jsonb);
    if (r->>'ok')::boolean is distinct from true or (r->>'imported')::int <> 2 then raise exception 'STEP 6b: import: %', r; end if;
    if (select count(*) from public.sync_event_log where aggregate_type = 'ACCOUNT_ROLE' and aggregate_id in ('imp-a', 'imp-b')) <> 2 then
      raise exception 'STEP 6b: imported roles not logged';
    end if;
  end if;
  r := public.admin_import_roles(alice_token, '[{"code": "imp-c", "name": "Imported C", "permissions": []}]'::jsonb);
  if r->>'reason' is distinct from 'ROLES_ALREADY_PRESENT' then raise exception 'STEP 6b: import over a catalogue: %', r; end if;

  -- 7. The admin's existing token now works: a role is saved and logged.
  r := public.admin_save_role(alice_token, null, 'Check Munshi', 'check', 'DAILY_LOGIN', array['dashboard', 'live-production']);
  if (r->>'ok')::boolean is distinct from true or r->'role'->>'roleCode' <> 'check-munshi' then
    raise exception 'STEP 7: role not saved: %', r;
  end if;
  if not exists (select 1 from public.sync_event_log where aggregate_type = 'ACCOUNT_ROLE' and aggregate_id = 'check-munshi') then
    raise exception 'STEP 7: ACCOUNT_ROLE not logged';
  end if;

  -- 8. Someone signs up on the other PC; the admin approves them with the role, once.
  perform set_config('request.jwt.claim.sub', ids[2]::text, true);
  r := public.sign_up('bob@check.test', 'bobpass99', 'Bob');
  bob_id := r->'person'->>'personId';
  perform set_config('request.jwt.claim.sub', ids[1]::text, true);
  r := public.admin_set_access(alice_token, bob_id, 'APPROVED', false, 'check-munshi', array['stock'], 'Munshi', 20);
  if (r->>'ok')::boolean is distinct from true or r->'person'->>'status' <> 'APPROVED' or r->'person'->>'roleCode' <> 'check-munshi' then
    raise exception 'STEP 8: approval: %', r;
  end if;
  if not exists (select 1 from public.sync_event_log
                  where aggregate_type = 'PERSON' and aggregate_id = bob_id and payload->>'status' = 'APPROVED') then
    raise exception 'STEP 8: approval not logged';
  end if;
  bob_version := (r->'person'->>'credentialVersion')::int;

  -- 9. A token works only on the PC it was issued to.
  perform set_config('request.jwt.claim.sub', ids[2]::text, true);
  r := public.admin_set_access(alice_token, bob_id, 'APPROVED', true, null, array[]::text[], '', 10);
  if r->>'reason' is distinct from 'ADMIN_REQUIRED' then raise exception 'STEP 9: token used from another PC: %', r; end if;

  -- 10. Five wrong passwords lock; the right one is then refused too.
  for i in 1..4 loop
    r := public.verify_login('bob@check.test', 'nope12345');
    if r->>'reason' is distinct from 'WRONG_CREDENTIALS' then raise exception 'STEP 10: attempt %: %', i, r; end if;
  end loop;
  r := public.verify_login('bob@check.test', 'nope12345');
  if r->>'reason' is distinct from 'LOCKED' then raise exception 'STEP 10: fifth attempt did not lock: %', r; end if;
  r := public.verify_login('bob@check.test', 'bobpass99');
  if r->>'reason' is distinct from 'LOCKED' then raise exception 'STEP 10: locked person signed in: %', r; end if;
  if exists (select 1 from public.sync_event_log where aggregate_id = bob_id and payload ? 'failedAttempts') then
    raise exception 'STEP 10: attempts reached the log';
  end if;

  -- 11. Revoking raises the credential version and ends the person's tokens; sign-in then says so.
  perform set_config('request.jwt.claim.sub', ids[1]::text, true);
  r := public.admin_set_access(alice_token, bob_id, 'REVOKED', false, 'check-munshi', array[]::text[], 'Munshi', 20);
  if (r->'person'->>'credentialVersion')::int <> bob_version + 1 then raise exception 'STEP 11: version not raised: %', r; end if;
  if exists (select 1 from public.person_tokens where person_id = bob_id) then raise exception 'STEP 11: tokens survived'; end if;
  update public.people set locked_until = null where id = bob_id;
  r := public.verify_login('bob@check.test', 'bobpass99');
  if r->>'reason' is distinct from 'ACCESS_REVOKED' then raise exception 'STEP 11: revoked person: %', r; end if;

  -- 12. An admin cannot remove their own access; a role in use cannot be deleted.
  r := public.admin_set_access(alice_token, (select id from public.people where lower(email) = 'alice@check.test'),
                               'REVOKED', true, null, array[]::text[], '', 10);
  if r->>'reason' is distinct from 'CANNOT_CHANGE_OWN_ACCESS' then raise exception 'STEP 12: self-revoke: %', r; end if;
  r := public.admin_delete_role(alice_token, 'check-munshi');
  if r->>'reason' is distinct from 'ROLE_IN_USE' then raise exception 'STEP 12: role in use deleted: %', r; end if;
  r := public.admin_save_role(alice_token, null, 'Check Spare', null, 'ALWAYS_LOGGED_IN', array[]::text[]);
  r := public.admin_delete_role(alice_token, 'check-spare');
  if (r->>'ok')::boolean is distinct from true or (r->'role'->>'deleted')::boolean is distinct from true then
    raise exception 'STEP 12: unused role not deleted: %', r;
  end if;
  if not exists (select 1 from public.sync_event_log
                  where aggregate_id = 'check-spare' and payload->>'revision' = '2' and (payload->>'deleted')::boolean) then
    raise exception 'STEP 12: deletion not logged';
  end if;

  -- 12b. An admin resets a password: the version rises, the lock clears, the old password stops.
  update public.people set locked_until = now() + interval '1 hour' where id = bob_id;
  r := public.admin_reset_password(alice_token, bob_id, 'reset4321');
  if (r->>'ok')::boolean is distinct from true or (r->'person'->>'credentialVersion')::int <> bob_version + 2 then
    raise exception 'STEP 12b: reset: %', r;
  end if;
  r := public.verify_login('bob@check.test', 'bobpass99');
  if r->>'reason' is distinct from 'WRONG_CREDENTIALS' then raise exception 'STEP 12b: old password after reset: %', r; end if;
  r := public.verify_login('bob@check.test', 'reset4321');
  if r->>'reason' is distinct from 'ACCESS_REVOKED' then raise exception 'STEP 12b: new password (still revoked): %', r; end if;

  -- 12c. An existing local account moves up with its own id, PENDING; its id and email are then taken.
  r := public.claim_existing_account('legacy-check-1', 'legacy@check.test', 'legacy123', 'Legacy');
  if (r->>'ok')::boolean is distinct from true or r->'person'->>'personId' <> 'legacy-check-1'
     or r->'person'->>'status' <> 'PENDING' then
    raise exception 'STEP 12c: claim: %', r;
  end if;
  r := public.claim_existing_account('legacy-check-1', 'other@check.test', 'legacy123', 'Legacy');
  if r->>'reason' is distinct from 'ID_TAKEN' then raise exception 'STEP 12c: id claimed twice: %', r; end if;
  r := public.claim_existing_account('legacy-check-2', 'LEGACY@check.test', 'legacy123', 'Legacy');
  if r->>'reason' is distinct from 'EMAIL_TAKEN' then raise exception 'STEP 12c: email claimed twice: %', r; end if;
  r := public.claim_existing_account('not an id!', 'x@check.test', 'legacy123', 'Legacy');
  if r->>'reason' is distinct from 'ID_INVALID' then raise exception 'STEP 12c: bad id: %', r; end if;

  -- 13. Changing a password raises the version; the old one stops working.
  r := public.change_password(alice_token, 'abcd1234', 'newpass77');
  if (r->>'ok')::boolean is distinct from true then raise exception 'STEP 13: change refused: %', r; end if;
  r := public.verify_login('alice@check.test', 'abcd1234');
  if r->>'reason' is distinct from 'WRONG_CREDENTIALS' then raise exception 'STEP 13: old password still works: %', r; end if;

  -- 14. Nothing secret is ever in the log.
  if exists (select 1 from public.sync_event_log
              where aggregate_type in ('PERSON', 'ACCOUNT_ROLE')
                and (payload ? 'verifier' or payload::text like '%$2a$%' or payload::text like '%$2b$%')) then
    raise exception 'STEP 14: a verifier reached the log';
  end if;

  -- 15. The audit trail is append-only.
  refused := false;
  begin
    update public.account_events set action = 'rewritten';
  exception when others then refused := sqlerrm = 'account_events is append-only';
  end;
  if not refused then raise exception 'STEP 15: account history could be rewritten'; end if;

  -- 16. A signed-in client reads no account table and cannot make an admin.
  set local role authenticated;
  refused := false;
  begin
    perform 1 from public.people;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'STEP 16: a client read people'; end if;
  refused := false;
  begin
    perform public.make_first_admin('bob@check.test');
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'STEP 16: a client could make an admin'; end if;
  reset role;

  raise exception 'ACCOUNTS_CHECK_PASSED: steps 1-16 with 6b, 12b and 12c (rolled back, nothing kept)';
end;
$$;
