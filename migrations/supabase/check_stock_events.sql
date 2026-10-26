-- NOT A MIGRATION. TEST PROJECT ONLY. Run whole through execute_sql or the SQL editor.
-- Functional check of 015 on TEST, after 011 and 015 are applied. Leaves nothing behind: the block
-- ends by raising, so the temporary device, its claim, the lease, the movements and their log rows
-- are all rolled back. PC rows are only READ, to copy not-null columns. Success is the error
-- message 'STOCK_EVENTS_CHECK_PASSED ...'.
do $$
declare
  b text := 'se-check-device';
  uid uuid := gen_random_uuid();
  holder uuid := gen_random_uuid();
  e bigint;
  r jsonb;
  -- A packet scanned out: TRANSFER_OUT stored POSITIVE, so the store PC's rule makes the delta negative.
  scan jsonb := jsonb_build_object('id', 'se-check-1', 'item_id', 'item-check', 'event_type', 'TRANSFER_OUT',
    'quantity', 5, 'unit_id', 'unit-check', 'note', 'Issued', 'created_by', 'user-check',
    'created_at', '2026-10-26T05:00:00.000Z', 'party_id', null, 'machine_program_id', null, 'balance_delta', -5);
begin
  insert into public.workstations
  select (jsonb_populate_record(null::public.workstations, to_jsonb(w)
          || jsonb_build_object('id', 'ws-se-check', 'device_id', b, 'workstation_code', 'SE-CHECK', 'name', 'se check'))).*
    from public.workstations w where w.device_id = 'desktop-main';
  insert into public.device_accounts
  select (jsonb_populate_record(null::public.device_accounts, to_jsonb(d)
          || jsonb_build_object('auth_user_id', uid, 'device_id', b, 'workstation_id', 'ws-se-check',
                                'label', 'se check', 'claim_holder', holder, 'claim_epoch', 1))).*
    from public.device_accounts d where d.device_id = 'desktop-main';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', uid, 'role', 'authenticated')::text, true);

  -- 1. No lease: refused, and nothing written.
  r := public.push_stock_event(1, holder, jsonb_build_array(scan || '{"lease_epoch": 0}'));
  if r->'results'->0->>'reason' is distinct from 'NOT_LEASE_HOLDER' then raise exception 'STEP 1: %', r; end if;

  e := (public.grant_domain_lease('RAW_MATERIAL_STORE', b, 'se check')->>'epoch')::bigint;
  scan := scan || jsonb_build_object('lease_epoch', e);

  -- 2. The movement lands, is logged once with the receiver's keys and the delta as sent, and a
  --    repeat is DUPLICATE.
  r := public.push_stock_event(1, holder, jsonb_build_array(scan));
  if r->'results'->0->>'outcome' is distinct from 'INSERTED' then raise exception 'STEP 2: %', r; end if;
  if (select payload from public.sync_event_log where dedupe_key = 'STOCK_EVENT:se-check-1')
     is distinct from jsonb_build_object('eventId', 'se-check-1', 'itemId', 'item-check', 'eventType', 'TRANSFER_OUT',
       'quantity', 5, 'unitId', 'unit-check', 'note', 'Issued', 'createdBy', 'user-check',
       'createdAt', '2026-10-26T05:00:00.000Z', 'partyId', null, 'machineProgramId', null, 'balanceDelta', -5) then
    raise exception 'STEP 2: payload %', (select payload from public.sync_event_log where dedupe_key = 'STOCK_EVENT:se-check-1');
  end if;
  if (select origin_device_id from public.inventory_stock_events where id = 'se-check-1') <> b then raise exception 'STEP 2: origin'; end if;
  r := public.push_stock_event(1, holder, jsonb_build_array(scan));
  if r->'results'->0->>'outcome' is distinct from 'DUPLICATE' then raise exception 'STEP 2 repeat: %', r; end if;

  -- 3. Refusals, each per row, in ONE call with a good row beside them that still lands.
  r := public.push_stock_event(1, holder, jsonb_build_array(
    scan || '{"quantity": 6, "balance_delta": -6}',                      -- same id, another movement
    scan || '{"id": "se-bad-delta", "balance_delta": -4}',               -- delta not the quantity's size
    scan || '{"id": "se-bad-type", "event_type": "STOLEN"}',             -- not a movement type
    scan || '{"id": "se-text-qty", "quantity": "5"}',                    -- a number as text
    scan || jsonb_build_object('id', 'se-stale', 'lease_epoch', e - 1),  -- stale lease epoch
    scan || '{"id": "se-check-2", "event_type": "TRANSFER_OUT", "quantity": -3, "balance_delta": -3, "note": null, "machine_program_id": "mp-check"}'));
  if (select string_agg(coalesce(x->>'reason', x->>'outcome'), ',' order by ord) from jsonb_array_elements(r->'results') with ordinality as t(x, ord))
     is distinct from 'IDENTITY_CONFLICT,DELTA_DOES_NOT_MATCH,PAYLOAD_INCOMPLETE,PAYLOAD_INCOMPLETE,NOT_LEASE_HOLDER,INSERTED' then
    raise exception 'STEP 3: %', r;
  end if;
  if (select count(*) from public.inventory_stock_events where id like 'se-%') <> 2 then raise exception 'STEP 3: a refused row was kept'; end if;
  if (select payload->>'machineProgramId' from public.sync_event_log where dedupe_key = 'STOCK_EVENT:se-check-2') is distinct from 'mp-check' then
    raise exception 'STEP 3: program id not carried';
  end if;

  -- 4. The unit is not the identity: the same movement in another unit (a W.5 unit correction on
  --    the store PC) is still DUPLICATE, never a conflict.
  r := public.push_stock_event(1, holder, jsonb_build_array(scan || '{"unit_id": "unit-other"}'));
  if r->'results'->0->>'outcome' is distinct from 'DUPLICATE' then raise exception 'STEP 4: %', r; end if;

  raise exception 'STOCK_EVENTS_CHECK_PASSED: all 4 steps (rolled back, nothing kept)';
end;
$$;
