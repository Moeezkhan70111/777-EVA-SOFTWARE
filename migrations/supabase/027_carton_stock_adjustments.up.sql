-- Manual carton adjustments reach the cloud (docs/42 section 11, local migration 103).
--
-- Two more movement types, CARTON_ADJUST_IN and CARTON_ADJUST_OUT, under the same CARTON_STOCK lease
-- and the same push as every other carton movement. reason is new: required on an adjustment, with who
-- made it, so every computer can say why the figure moved. Who may adjust (an administrator) is decided
-- on the writing computer, as for a void: a carton push carries no person token (docs/42 section 10.3).
--
-- Requires 026. No revoke here: create or replace keeps each function's grants, so this can run through
-- execute_sql as well as the SQL editor. TEST project first.

begin;

alter table public.carton_stock_events add column if not exists reason text;

alter table public.carton_stock_events drop constraint if exists carton_stock_events_event_type_check;
alter table public.carton_stock_events add constraint carton_stock_events_event_type_check
  check (event_type in ('MANUAL_PRODUCE', 'GATEPASS_ISSUE', 'GATEPASS_CANCEL', 'MANUAL_PRODUCTION_VOID', 'CARTON_ADJUST_IN', 'CARTON_ADJUST_OUT'));

alter table public.carton_stock_events drop constraint if exists carton_stock_events_check;
alter table public.carton_stock_events add constraint carton_stock_events_check
  check (balance_delta = case when event_type in ('GATEPASS_ISSUE', 'MANUAL_PRODUCTION_VOID', 'CARTON_ADJUST_OUT') then -quantity else quantity end);

alter table public.carton_stock_events drop constraint if exists carton_stock_events_adjustment_said_why;
alter table public.carton_stock_events add constraint carton_stock_events_adjustment_said_why
  check (event_type not in ('CARTON_ADJUST_IN', 'CARTON_ADJUST_OUT')
         or (char_length(btrim(coalesce(reason, ''))) > 0 and char_length(btrim(coalesce(created_by, ''))) > 0));

create or replace function public.log_carton_stock_event_insert() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(777, 1);
  insert into public.sync_event_log (
    dedupe_key, aggregate_type, aggregate_id, payload, origin_device_id, factory_id
  )
  values (
    'CARTON_STOCK_EVENT:' || new.id,
    'CARTON_STOCK_EVENT',
    new.id,
    jsonb_build_object(
      'eventId', new.id,
      'productVariantId', new.product_variant_id,
      'eventType', new.event_type,
      'quantity', new.quantity,
      'balanceDelta', new.balance_delta,
      'locationType', new.location_type,
      'locationId', new.location_id,
      'createdBy', new.created_by,
      'createdAt', new.created_at,
      'manualProductionEntryId', new.manual_production_entry_id,
      'gatepassId', new.gatepass_id,
      'gatepassLineId', new.gatepass_line_id,
      'reason', new.reason
    ),
    new.origin_device_id,
    null
  )
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;

create or replace function public.carton_stock_event_problem(item jsonb) returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_quantity integer;
begin
  if item->>'id' is null or item->>'product_variant_id' is null
     or coalesce(item->>'event_type', '') not in ('MANUAL_PRODUCE', 'GATEPASS_ISSUE', 'GATEPASS_CANCEL', 'MANUAL_PRODUCTION_VOID', 'CARTON_ADJUST_IN', 'CARTON_ADJUST_OUT')
     or item->>'location_type' is distinct from 'WAREHOUSE'
     or char_length(btrim(coalesce(item->>'location_id', ''))) = 0
     or jsonb_typeof(item->'quantity') is distinct from 'number'
     or jsonb_typeof(item->'balance_delta') is distinct from 'number'
     or coalesce(item->>'quantity', '') !~ '^[1-9][0-9]{0,8}$'
     or coalesce(item->>'balance_delta', '') !~ '^-?[1-9][0-9]{0,8}$'
     or coalesce(item->>'created_at', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'
     or coalesce(item->>'lease_epoch', '') !~ '^[0-9]{1,18}$' then
    return 'PAYLOAD_INCOMPLETE';
  end if;
  if item->>'event_type' in ('MANUAL_PRODUCE', 'MANUAL_PRODUCTION_VOID') and item->>'manual_production_entry_id' is null then
    return 'PAYLOAD_INCOMPLETE';
  end if;
  if item->>'event_type' in ('GATEPASS_ISSUE', 'GATEPASS_CANCEL') and (item->>'gatepass_id' is null or item->>'gatepass_line_id' is null) then
    return 'PAYLOAD_INCOMPLETE';
  end if;
  if item->>'event_type' in ('CARTON_ADJUST_IN', 'CARTON_ADJUST_OUT')
     and (char_length(btrim(coalesce(item->>'reason', ''))) = 0 or char_length(btrim(coalesce(item->>'created_by', ''))) = 0) then
    return 'PAYLOAD_INCOMPLETE';
  end if;
  v_quantity := (item->>'quantity')::integer;
  if (item->>'balance_delta')::integer <> (case when item->>'event_type' in ('GATEPASS_ISSUE', 'MANUAL_PRODUCTION_VOID', 'CARTON_ADJUST_OUT') then -v_quantity else v_quantity end) then
    return 'DELTA_DOES_NOT_MATCH';
  end if;
  return null;
end;
$$;

create or replace function public.push_carton_stock_event(p_epoch bigint, p_holder uuid, p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  account public.device_accounts%rowtype;
  item jsonb;
  problem text;
  existing public.carton_stock_events%rowtype;
  outcomes jsonb := '[]'::jsonb;
  inserted int;
begin
  account := public.claim_is_current(p_epoch, p_holder);
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'ROWS_NOT_AN_ARRAY' using errcode = '22023';
  end if;

  for item in select * from jsonb_array_elements(p_rows) loop
    problem := public.carton_stock_event_problem(item);
    if problem is null and not public.lease_holds('CARTON_STOCK', account.device_id, (item->>'lease_epoch')::bigint) then
      problem := 'NOT_LEASE_HOLDER';
    end if;
    if problem is not null then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', problem);
      continue;
    end if;

    select * into existing from public.carton_stock_events where id = item->>'id';
    if found then
      if existing.product_variant_id = item->>'product_variant_id'
         and existing.event_type = item->>'event_type'
         and existing.quantity = (item->>'quantity')::integer
         and existing.location_id = item->>'location_id'
         and existing.created_at = item->>'created_at' then
        outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'DUPLICATE');
      else
        outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'IDENTITY_CONFLICT');
      end if;
      continue;
    end if;

    -- ON CONFLICT with no target: a second void of one entry, or a second cancel of one issued line,
    -- meets a unique key and is answered for, never raised (one row must not abort the batch).
    insert into public.carton_stock_events (
      id, product_variant_id, event_type, quantity, balance_delta, location_type, location_id,
      created_by, created_at, manual_production_entry_id, gatepass_id, gatepass_line_id, reason, origin_device_id
    ) values (
      item->>'id', item->>'product_variant_id', item->>'event_type', (item->>'quantity')::integer,
      (item->>'balance_delta')::integer, item->>'location_type', item->>'location_id', item->>'created_by',
      item->>'created_at', item->>'manual_production_entry_id', item->>'gatepass_id', item->>'gatepass_line_id',
      item->>'reason', account.device_id
    )
    on conflict do nothing;
    get diagnostics inserted = row_count;
    if inserted > 0 then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'INSERTED');
    else
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'MOVEMENT_ALREADY_RECORDED');
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'epoch', account.claim_epoch, 'results', outcomes);
end;
$$;

commit;
