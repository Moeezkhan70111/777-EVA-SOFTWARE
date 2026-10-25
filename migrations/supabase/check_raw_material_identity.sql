-- NOT A MIGRATION. TEST PROJECT ONLY. Run whole through execute_sql or the SQL editor.
-- Functional check of 012 on TEST, after 011 and 012 are applied. Leaves nothing behind: the
-- block ends by raising, so the temporary device, its claim, the lease, the mirror rows and the log
-- rows are all rolled back. PC2's own enrolment and claim are only READ (to copy not-null columns),
-- never used. Success is the error message 'RM_IDENTITY_CHECK_PASSED ...'.
do $$
declare
  b text := 'rm-check-device';
  uid uuid := gen_random_uuid();
  holder uuid := gen_random_uuid();
  e bigint;
  r jsonb;
  run jsonb := jsonb_build_object('id', 'rmb-check', 'party_id', 'party-check', 'item_id', 'item-check',
    'start_sequence', 11, 'end_sequence', 13, 'quantity', 3, 'created_at', '2026-10-25T05:00:00.000Z',
    'created_by', 'user-check', 'requested_by', null);
  packet jsonb := jsonb_build_object('id', 'rmq-check-12', 'batch_id', 'rmb-check', 'party_id', 'party-check',
    'item_id', 'item-check', 'sequence', 12, 'packing_quantity', 2.5, 'packing_unit_id', 'unit-check',
    'created_at', '2026-10-25T05:00:00.000Z');
begin
  -- A temporary device that has claimed, copied from PC2's row for the not-null columns.
  insert into public.workstations
  select (jsonb_populate_record(null::public.workstations, to_jsonb(w)
          || jsonb_build_object('id', 'ws-rm-check', 'device_id', b, 'workstation_code', 'RM-CHECK', 'name', 'rm check'))).*
    from public.workstations w where w.device_id = 'desktop-main';
  insert into public.device_accounts
  select (jsonb_populate_record(null::public.device_accounts, to_jsonb(d)
          || jsonb_build_object('auth_user_id', uid, 'device_id', b, 'workstation_id', 'ws-rm-check',
                                'label', 'rm check', 'claim_holder', holder, 'claim_epoch', 1))).*
    from public.device_accounts d where d.device_id = 'desktop-main';
  -- Calls below are made AS that device: auth.uid() reads the JWT subject.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', uid, 'role', 'authenticated')::text, true);

  -- 1. No lease: refused, and nothing written.
  r := public.push_raw_material_qr_batch(1, holder, jsonb_build_array(run || '{"lease_epoch": 0}'));
  if r->'results'->0->>'reason' is distinct from 'NOT_LEASE_HOLDER' then raise exception 'STEP 1: %', r; end if;

  e := (public.grant_domain_lease('RAW_MATERIAL_STORE', b, 'rm check')->>'epoch')::bigint;
  run := run || jsonb_build_object('lease_epoch', e);
  packet := packet || jsonb_build_object('lease_epoch', e);

  -- 2. The run lands, is logged once with the reader's keys, and a repeat is DUPLICATE.
  r := public.push_raw_material_qr_batch(1, holder, jsonb_build_array(run));
  if r->'results'->0->>'outcome' is distinct from 'INSERTED' then raise exception 'STEP 2: %', r; end if;
  if (select payload from public.sync_event_log where dedupe_key = 'RAW_MATERIAL_QR_BATCH:rmb-check')
     is distinct from jsonb_build_object('batchId', 'rmb-check', 'partyId', 'party-check', 'itemId', 'item-check',
       'startSequence', 11, 'endSequence', 13, 'quantity', 3, 'createdAt', '2026-10-25T05:00:00.000Z',
       'createdBy', 'user-check', 'requestedBy', null) then
    raise exception 'STEP 2: run payload %', (select payload from public.sync_event_log where dedupe_key = 'RAW_MATERIAL_QR_BATCH:rmb-check');
  end if;
  if (select origin_device_id from public.raw_material_qr_batches where id = 'rmb-check') <> b then raise exception 'STEP 2: origin'; end if;
  r := public.push_raw_material_qr_batch(1, holder, jsonb_build_array(run));
  if r->'results'->0->>'outcome' is distinct from 'DUPLICATE' then raise exception 'STEP 2 repeat: %', r; end if;

  -- 3. Refusals, each per row, in ONE call with a good row beside them that still lands.
  r := public.push_raw_material_qr_batch(1, holder, jsonb_build_array(
    run || '{"start_sequence": 12, "end_sequence": 14}',              -- same id, other content
    run || '{"id": "rmb-bad-sum", "quantity": 5}',                     -- serials do not add up
    run || '{"id": "rmb-no-date", "created_at": null}',                -- incomplete
    run || jsonb_build_object('id', 'rmb-stale', 'lease_epoch', e - 1),-- stale lease epoch
    run || '{"id": "rmb-check-2", "start_sequence": 14, "end_sequence": 14, "quantity": 1}'));
  if (select string_agg(x->>'id' || '=' || coalesce(x->>'reason', x->>'outcome'), ',') from jsonb_array_elements(r->'results') x)
     is distinct from 'rmb-check=IDENTITY_CONFLICT,rmb-bad-sum=RUN_DOES_NOT_ADD_UP,rmb-no-date=PAYLOAD_INCOMPLETE,rmb-stale=NOT_LEASE_HOLDER,rmb-check-2=INSERTED' then
    raise exception 'STEP 3: %', r;
  end if;

  -- 4. Packets: the run must be there, the serial inside it, and once only.
  r := public.push_raw_material_qr(1, holder, jsonb_build_array(
    packet || '{"id": "rmq-orphan", "batch_id": "rmb-nowhere"}',
    packet || '{"id": "rmq-outside", "sequence": 14}',
    packet || '{"id": "rmq-half", "packing_unit_id": null}',
    packet,
    packet || '{"id": "rmq-same-serial"}'));
  if (select string_agg(x->>'id' || '=' || coalesce(x->>'reason', x->>'outcome'), ',') from jsonb_array_elements(r->'results') x)
     is distinct from 'rmq-orphan=RUN_NOT_REGISTERED_YET,rmq-outside=PACKET_OUTSIDE_ITS_RUN,rmq-half=PAYLOAD_INCOMPLETE,rmq-check-12=INSERTED,rmq-same-serial=SERIAL_CLASH' then
    raise exception 'STEP 4: %', r;
  end if;
  if (select payload->>'packingQuantity' from public.sync_event_log where dedupe_key = 'RAW_MATERIAL_QR:rmq-check-12') <> '2.5' then
    raise exception 'STEP 4: packing did not round-trip';
  end if;
  r := public.push_raw_material_qr(1, holder, jsonb_build_array(packet));
  if r->'results'->0->>'outcome' is distinct from 'DUPLICATE' then raise exception 'STEP 4 repeat: %', r; end if;

  -- 5. Logged unscoped, and exactly once each.
  if (select count(*) from public.sync_event_log
       where dedupe_key in ('RAW_MATERIAL_QR_BATCH:rmb-check', 'RAW_MATERIAL_QR_BATCH:rmb-check-2', 'RAW_MATERIAL_QR:rmq-check-12')
         and factory_id is null and origin_device_id = b) <> 3 then
    raise exception 'STEP 5: log rows wrong';
  end if;

  -- 6. A device whose claim was superseded writes nothing.
  begin
    perform public.push_raw_material_qr_batch(1, gen_random_uuid(), jsonb_build_array(run));
    raise exception 'STEP 6: a superseded claim was accepted';
  exception when insufficient_privilege then
    null;
  end;

  raise exception 'RM_IDENTITY_CHECK_PASSED: all 6 steps (rolled back, nothing kept)';
end;
$$;
