-- NOT A MIGRATION. TEST PROJECT ONLY. Run whole through execute_sql or the SQL editor.
-- Functional check of 016 on TEST, after 011, 015 and 016 are applied. Leaves nothing behind: the
-- block ends by raising, so the temporary device, its claim, the lease, the movements, their log rows
-- and the ring are all rolled back. PC rows are only READ, to copy not-null columns. Success is the
-- error message 'DOORBELL_CHECK_PASSED ...'.
do $$
declare
  b text := 'db-check-device';
  uid uuid := gen_random_uuid();
  holder uuid := gen_random_uuid();
  e bigint;
  r jsonb;
  first_seq bigint;
  last_seq bigint;
  seen int;
  scan jsonb := jsonb_build_object('item_id', 'item-check', 'event_type', 'RECEIVE', 'quantity', 5, 'unit_id', 'unit-check',
    'note', null, 'created_by', null, 'created_at', '2026-10-27T05:00:00.000Z', 'party_id', null, 'machine_program_id', null,
    'balance_delta', 5);
begin
  insert into public.workstations
  select (jsonb_populate_record(null::public.workstations, to_jsonb(w)
          || jsonb_build_object('id', 'ws-db-check', 'device_id', b, 'workstation_code', 'DB-CHECK', 'name', 'db check'))).*
    from public.workstations w where w.device_id = 'desktop-main';
  insert into public.device_accounts
  select (jsonb_populate_record(null::public.device_accounts, to_jsonb(d)
          || jsonb_build_object('auth_user_id', uid, 'device_id', b, 'workstation_id', 'ws-db-check',
                                'label', 'db check', 'claim_holder', holder, 'claim_epoch', 1))).*
    from public.device_accounts d where d.device_id = 'desktop-main';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', uid, 'role', 'authenticated')::text, true);
  e := (public.grant_domain_lease('RAW_MATERIAL_STORE', b, 'db check')->>'epoch')::bigint;

  -- 1. One push of two movements rings ONCE: the doorbell holds the first row's position, not the last.
  r := public.push_stock_event(1, holder, jsonb_build_array(
    scan || jsonb_build_object('id', 'db-check-1', 'lease_epoch', e),
    scan || jsonb_build_object('id', 'db-check-2', 'lease_epoch', e)));
  if (select count(*) from jsonb_array_elements(r->'results') x where x->>'outcome' = 'INSERTED') <> 2 then raise exception 'STEP 1: %', r; end if;
  select min(seq), max(seq) into first_seq, last_seq from public.sync_event_log where dedupe_key in ('STOCK_EVENT:db-check-1', 'STOCK_EVENT:db-check-2');
  if first_seq = last_seq then raise exception 'STEP 1: expected two log rows'; end if;
  if (select last_seq || '|' || last_origin_device_id from public.sync_log_doorbell where scope = 'global')
     is distinct from first_seq || '|' || b then
    raise exception 'STEP 1: doorbell %', (select to_jsonb(d) from public.sync_log_doorbell d where scope = 'global');
  end if;

  -- 2. The enrolled device reads the doorbell through its policy; nobody can write it.
  perform set_config('role', 'authenticated', true);
  select count(*) into seen from public.sync_log_doorbell where scope = 'global';
  if seen <> 1 then raise exception 'STEP 2: the device sees % doorbell rows', seen; end if;
  begin
    update public.sync_log_doorbell set last_seq = 0;
    raise exception 'STEP 2: a device could write the doorbell';
  exception when insufficient_privilege then
    null;
  end;
  execute 'reset role';

  raise exception 'DOORBELL_CHECK_PASSED: both steps (rolled back, nothing kept)';
end;
$$;
