-- NOT A MIGRATION. TEST PROJECT ONLY. Run whole through execute_sql or the SQL editor.
-- Functional check of 038, 039 and 040 on TEST, through 013's real push_leased_record (docs/55). Like
-- check_leased_records.sql it leaves nothing behind: the block ends by raising, so the temporary device, its claim,
-- its number block, the leases it is granted, the records and the log rows are all rolled back, and no other
-- computer ever sees them. desktop-main's rows are only READ, to copy not-null columns. Success is the error message
-- 'PARTY_CLAIM_RECORDS_CHECK_PASSED ...'.
--
-- What it proves, per lease (the cloud half of "the store asks, Accounts posts"):
--   1. Holding only the store lease: a claim REQUEST lands; a CLAIM, a REJECTION, a PURCHASE BILL and a SALE RETURN
--      are refused NOT_LEASE_HOLDER. So the store computer cannot post money, whatever its client sends.
--   2. Holding ACCOUNTS: the claim lands, its reversal (revision 2) updates it, the same revision again is DUPLICATE,
--      a rejection and a purchase bill land. The request is NOT accepted from the accounts holder.
--   3. A sale return lands only from the SALES_DISPATCH holder.
--   4. Each is logged once as TYPE:id:revision, so every reader receives it once.
do $$
declare
  b text := 'claim-check-device';
  uid uuid := gen_random_uuid();
  holder uuid := gen_random_uuid();
  store_epoch bigint;
  accounts_epoch bigint;
  sales_epoch bigint;
  r jsonb;
  outcomes text;
  rec jsonb := jsonb_build_object('revision', 1, 'deleted', false);
  request jsonb;
  claim jsonb;
  rejection jsonb;
  bill jsonb;
  sale_return jsonb;
begin
  insert into public.workstations
  select (jsonb_populate_record(null::public.workstations, to_jsonb(w)
          || jsonb_build_object('id', 'ws-claim-check', 'device_id', b, 'workstation_code', 'CLAIM-CHECK', 'name', 'claim check'))).*
    from public.workstations w where w.device_id = 'desktop-main';
  insert into public.device_accounts
  select (jsonb_populate_record(null::public.device_accounts, to_jsonb(d)
          || jsonb_build_object('auth_user_id', uid, 'device_id', b, 'workstation_id', 'ws-claim-check',
                                'label', 'claim check', 'claim_holder', holder, 'claim_epoch', 1))).*
    from public.device_accounts d where d.device_id = 'desktop-main';
  insert into public.number_blocks (block, device_id, auth_user_id) values (996, b, uid);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', uid, 'role', 'authenticated')::text, true);

  request := rec || jsonb_build_object('aggregate_type', 'PARTY_CLAIM_REQUEST', 'record_id', 'cr-check',
    'body', jsonb_build_object('id', 'cr-check', 'request_number', 'CR-996001', 'party_id', 'party-check', 'quantity_pairs', 2));
  claim := rec || jsonb_build_object('aggregate_type', 'PARTY_CLAIM', 'record_id', 'cl-check',
    'body', jsonb_build_object('id', 'cl-check', 'request_id', 'cr-check', 'rate_paisa', 5000, 'amount_paisa', 10000, 'status', 'POSTED'));
  rejection := rec || jsonb_build_object('aggregate_type', 'PARTY_CLAIM_REJECTION', 'record_id', 'rj-check',
    'body', jsonb_build_object('id', 'rj-check', 'request_id', 'cr-check-2', 'reason', 'check'));
  bill := rec || jsonb_build_object('aggregate_type', 'PURCHASE_VOUCHER', 'record_id', 'pv-check',
    'body', jsonb_build_object('id', 'pv-check', 'party_id', 'party-check', 'total_paisa', 10000));
  sale_return := rec || jsonb_build_object('aggregate_type', 'SALE_RETURN', 'record_id', 'sr-check',
    'body', jsonb_build_object('id', 'sr-check', 'sale_voucher_id', 'sv-check', 'amount_paisa', 10000));

  -- 1. The store lease only.
  store_epoch := (public.grant_domain_lease('RAW_MATERIAL_STORE', b, 'claim check: store')->>'epoch')::bigint;
  r := public.push_leased_record(1, holder, jsonb_build_array(
    request || jsonb_build_object('lease_epoch', store_epoch),
    claim || jsonb_build_object('lease_epoch', store_epoch),
    rejection || jsonb_build_object('lease_epoch', store_epoch),
    bill || jsonb_build_object('lease_epoch', store_epoch),
    sale_return || jsonb_build_object('lease_epoch', store_epoch)));
  select string_agg(x->>'record_id' || '=' || coalesce(x->>'reason', x->>'outcome'), ',') into outcomes from jsonb_array_elements(r->'results') x;
  if outcomes is distinct from 'cr-check=INSERTED,cl-check=NOT_LEASE_HOLDER,rj-check=NOT_LEASE_HOLDER,pv-check=NOT_LEASE_HOLDER,sr-check=NOT_LEASE_HOLDER' then
    raise exception 'STEP 1: %', outcomes;
  end if;

  -- 2. ACCOUNTS: claim, reversal, duplicate, rejection, bill. A request is not the accounts holder's to write.
  accounts_epoch := (public.grant_domain_lease('ACCOUNTS', b, 'claim check: accounts')->>'epoch')::bigint;
  perform public.grant_domain_lease('RAW_MATERIAL_STORE', 'desktop-main', 'claim check: store elsewhere');
  claim := claim || jsonb_build_object('lease_epoch', accounts_epoch);
  r := public.push_leased_record(1, holder, jsonb_build_array(
    claim,
    claim || jsonb_build_object('revision', 2, 'body', (claim->'body') || '{"status": "REVERSED", "reversal_reason": "check"}'),
    claim || jsonb_build_object('revision', 2, 'body', (claim->'body') || '{"status": "REVERSED", "reversal_reason": "check"}'),
    rejection || jsonb_build_object('lease_epoch', accounts_epoch),
    bill || jsonb_build_object('lease_epoch', accounts_epoch),
    request || jsonb_build_object('record_id', 'cr-check-2', 'lease_epoch', accounts_epoch)));
  select string_agg(x->>'record_id' || '=' || coalesce(x->>'reason', x->>'outcome'), ',') into outcomes from jsonb_array_elements(r->'results') x;
  if outcomes is distinct from 'cl-check=INSERTED,cl-check=UPDATED,cl-check=DUPLICATE,rj-check=INSERTED,pv-check=INSERTED,cr-check-2=NOT_LEASE_HOLDER' then
    raise exception 'STEP 2: %', outcomes;
  end if;
  if (select revision || ':' || (body->>'status') from public.leased_records where record_id = 'cl-check') <> '2:REVERSED' then
    raise exception 'STEP 2: claim is not at its reversal';
  end if;

  -- 3. A sale return, only from the sales holder.
  sales_epoch := (public.grant_domain_lease('SALES_DISPATCH', b, 'claim check: sales')->>'epoch')::bigint;
  r := public.push_leased_record(1, holder, jsonb_build_array(sale_return || jsonb_build_object('lease_epoch', sales_epoch)));
  if r->'results'->0->>'outcome' is distinct from 'INSERTED' then raise exception 'STEP 3: %', r; end if;

  -- 4. Logged once per revision.
  if (select string_agg(dedupe_key, ',' order by dedupe_key collate "C") from public.sync_event_log
       where aggregate_id in ('cr-check', 'cl-check', 'rj-check', 'pv-check', 'sr-check', 'cr-check-2'))
     is distinct from 'PARTY_CLAIM:cl-check:1,PARTY_CLAIM:cl-check:2,PARTY_CLAIM_REJECTION:rj-check:1,PARTY_CLAIM_REQUEST:cr-check:1,PURCHASE_VOUCHER:pv-check:1,SALE_RETURN:sr-check:1' then
    raise exception 'STEP 4: log %', (select string_agg(dedupe_key, ',' order by dedupe_key collate "C") from public.sync_event_log
       where aggregate_id in ('cr-check', 'cl-check', 'rj-check', 'pv-check', 'sr-check', 'cr-check-2'));
  end if;

  raise exception 'PARTY_CLAIM_RECORDS_CHECK_PASSED: all 4 steps (rolled back, nothing kept)';
end;
$$;
