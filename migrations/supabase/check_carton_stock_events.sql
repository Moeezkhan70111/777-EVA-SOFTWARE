-- NOT A MIGRATION. TEST PROJECT ONLY. Run whole through execute_sql or the SQL editor.
-- Functional check of 026 on TEST, after 011 and 026 are applied. Leaves nothing behind: the block
-- ends by raising, so the temporary device, its claim, the carton lease, the movements and their log
-- rows are all rolled back. PC rows are only READ, to copy not-null columns. Success is the error
-- message 'CARTON_STOCK_EVENTS_CHECK_PASSED ...'. Set up exactly as check_stock_events.sql.
do $$
declare
  b text := 'cs-check-device';
  uid uuid := gen_random_uuid();
  holder uuid := gen_random_uuid();
  e bigint;
  r jsonb;
  -- Manual Production: 10 dozen, 20 cartons into the store.
  made jsonb := jsonb_build_object('id', 'cs-check-1', 'product_variant_id', 'v-check', 'event_type', 'MANUAL_PRODUCE',
    'quantity', 20, 'balance_delta', 20, 'location_type', 'WAREHOUSE', 'location_id', 'factory-check',
    'created_by', 'aslam', 'created_at', '2026-11-03T05:00:00.000Z',
    'manual_production_entry_id', 'mpe-check', 'gatepass_id', null, 'gatepass_line_id', null);
  issue jsonb := jsonb_build_object('id', 'cs-check-2', 'product_variant_id', 'v-check', 'event_type', 'GATEPASS_ISSUE',
    'quantity', 5, 'balance_delta', -5, 'location_type', 'WAREHOUSE', 'location_id', 'factory-check',
    'created_by', 'clerk', 'created_at', '2026-11-03T05:10:00.000Z',
    'manual_production_entry_id', null, 'gatepass_id', 'gp-check', 'gatepass_line_id', 'gpl-check');
begin
  insert into public.workstations
  select (jsonb_populate_record(null::public.workstations, to_jsonb(w)
          || jsonb_build_object('id', 'ws-cs-check', 'device_id', b, 'workstation_code', 'CS-CHECK', 'name', 'cs check'))).*
    from public.workstations w where w.device_id = 'desktop-main';
  insert into public.device_accounts
  select (jsonb_populate_record(null::public.device_accounts, to_jsonb(d)
          || jsonb_build_object('auth_user_id', uid, 'device_id', b, 'workstation_id', 'ws-cs-check',
                                'label', 'cs check', 'claim_holder', holder, 'claim_epoch', 1))).*
    from public.device_accounts d where d.device_id = 'desktop-main';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', uid, 'role', 'authenticated')::text, true);

  -- 1. Without the carton lease: refused, and nothing written.
  r := public.push_carton_stock_event(1, holder, jsonb_build_array(made || '{"lease_epoch": 0}'));
  if r->'results'->0->>'reason' is distinct from 'NOT_LEASE_HOLDER' then raise exception 'STEP 1: %', r; end if;
  if exists (select 1 from public.carton_stock_events where id like 'cs-%') then raise exception 'STEP 1: a refused row was kept'; end if;

  e := (public.grant_domain_lease('CARTON_STOCK', b, 'cs check')->>'epoch')::bigint;
  made := made || jsonb_build_object('lease_epoch', e);
  issue := issue || jsonb_build_object('lease_epoch', e);

  -- 2. The movement lands under the proven device, is logged once -- unscoped, with the receiver's
  --    keys -- and a repeat is DUPLICATE.
  r := public.push_carton_stock_event(1, holder, jsonb_build_array(made));
  if r->'results'->0->>'outcome' is distinct from 'INSERTED' then raise exception 'STEP 2: %', r; end if;
  if (select payload from public.sync_event_log where dedupe_key = 'CARTON_STOCK_EVENT:cs-check-1')
     is distinct from jsonb_build_object('eventId', 'cs-check-1', 'productVariantId', 'v-check', 'eventType', 'MANUAL_PRODUCE',
       'quantity', 20, 'balanceDelta', 20, 'locationType', 'WAREHOUSE', 'locationId', 'factory-check',
       'createdBy', 'aslam', 'createdAt', '2026-11-03T05:00:00.000Z',
       'manualProductionEntryId', 'mpe-check', 'gatepassId', null, 'gatepassLineId', null) then
    raise exception 'STEP 2: payload %', (select payload from public.sync_event_log where dedupe_key = 'CARTON_STOCK_EVENT:cs-check-1');
  end if;
  if (select factory_id from public.sync_event_log where dedupe_key = 'CARTON_STOCK_EVENT:cs-check-1') is not null then raise exception 'STEP 2: scoped'; end if;
  if (select origin_device_id from public.carton_stock_events where id = 'cs-check-1') <> b then raise exception 'STEP 2: origin'; end if;
  r := public.push_carton_stock_event(1, holder, jsonb_build_array(made));
  if r->'results'->0->>'outcome' is distinct from 'DUPLICATE' then raise exception 'STEP 2 repeat: %', r; end if;

  -- 3. Refusals, each per row, in ONE call with a good row beside them that still lands.
  r := public.push_carton_stock_event(1, holder, jsonb_build_array(
    made || '{"quantity": 30, "balance_delta": 30}',                         -- same id, another movement
    made || '{"id": "cs-bad-sign", "balance_delta": -20}',                    -- production that takes out
    made || '{"id": "cs-bad-type", "event_type": "STOLEN"}',                  -- not a movement type
    made || '{"id": "cs-text-qty", "quantity": "20"}',                        -- a number as text
    issue || '{"id": "cs-no-line", "gatepass_line_id": null}',                -- an issue naming no line
    made || '{"id": "cs-bad-place", "location_type": "GATE"}',                -- only the store moves
    issue || jsonb_build_object('id', 'cs-stale', 'lease_epoch', e - 1),      -- stale lease epoch
    issue));
  if (select string_agg(coalesce(x->>'reason', x->>'outcome'), ',' order by ord) from jsonb_array_elements(r->'results') with ordinality as t(x, ord))
     is distinct from 'IDENTITY_CONFLICT,DELTA_DOES_NOT_MATCH,PAYLOAD_INCOMPLETE,PAYLOAD_INCOMPLETE,PAYLOAD_INCOMPLETE,PAYLOAD_INCOMPLETE,NOT_LEASE_HOLDER,INSERTED' then
    raise exception 'STEP 3: %', r;
  end if;
  if (select count(*) from public.carton_stock_events where id like 'cs-%') <> 2 then raise exception 'STEP 3: a refused row was kept'; end if;

  -- 4. A cancel happens once, and a void happens once: a second one under a new id is refused by
  --    the unique keys, answered per row, and never logged.
  r := public.push_carton_stock_event(1, holder, jsonb_build_array(
    issue || '{"id": "cs-cancel-1", "event_type": "GATEPASS_CANCEL", "balance_delta": 5}',
    issue || '{"id": "cs-cancel-2", "event_type": "GATEPASS_CANCEL", "balance_delta": 5}',
    made || '{"id": "cs-void-1", "event_type": "MANUAL_PRODUCTION_VOID", "balance_delta": -20}',
    made || '{"id": "cs-void-2", "event_type": "MANUAL_PRODUCTION_VOID", "balance_delta": -20}'));
  if (select string_agg(coalesce(x->>'reason', x->>'outcome'), ',' order by ord) from jsonb_array_elements(r->'results') with ordinality as t(x, ord))
     is distinct from 'INSERTED,MOVEMENT_ALREADY_RECORDED,INSERTED,MOVEMENT_ALREADY_RECORDED' then
    raise exception 'STEP 4: %', r;
  end if;
  if (select count(*) from public.sync_event_log where aggregate_type = 'CARTON_STOCK_EVENT' and aggregate_id like 'cs-%') <> 4 then
    raise exception 'STEP 4: the log holds % carton rows, not 4', (select count(*) from public.sync_event_log where aggregate_type = 'CARTON_STOCK_EVENT' and aggregate_id like 'cs-%');
  end if;

  -- 5. The figure the log carries sums to what happened: +20 -5 +5 -20 = 0.
  if (select sum((payload->>'balanceDelta')::int) from public.sync_event_log where aggregate_type = 'CARTON_STOCK_EVENT' and aggregate_id like 'cs-%') <> 0 then
    raise exception 'STEP 5: the movements do not sum to zero';
  end if;

  raise exception 'CARTON_STOCK_EVENTS_CHECK_PASSED: all 5 steps (rolled back, nothing kept)';
end;
$$;
