-- Carton stock movements reach the other computers, so every PC -- the boss's read-only PC included --
-- shows the same carton figure (docs/42).
--
-- WHAT TRAVELS. One row of the writer's carton_stock_events (local migration 101) per movement:
-- Manual Production (+), a gatepass taking out at once the part QR cartons cannot cover (-), its
-- cancel putting that back (+), and a voided Manual Production entry taking its cartons back out (-). quantity is
-- cartons, always positive. balance_delta is the change it made, and this table checks it against
-- the type exactly as the computers do (@erp/domain cartonStockDelta): the sign is the type's.
--
-- THE GATEPASS AND MANUAL PRODUCTION IDS ARE REFERENCES ONLY. Neither document replicates, so they
-- name rows that exist only on the computer that wrote them. No foreign key, no check that they exist.
-- The product variant is not checked either, as raw material's item is not (015): a receiving
-- computer waits for it, and a push ahead of its variant must not be refused for good.
--
-- LEASED under a lease of its own, CARTON_STOCK (docs/42 section 6): one writer for every movement of
-- the figure, so no two computers can take the same cartons out, and Manual Production's machine-day
-- program and contractor ledger -- which do not replicate -- are never split between computers.
-- Append-only: an id is one movement for good. The same id with the same movement is DUPLICATE,
-- with a different one IDENTITY_CONFLICT. A second void of one entry, or a second cancel of one
-- issued line, is refused MOVEMENT_ALREADY_RECORDED, by the same unique keys the computers hold.
--
-- UNSCOPED, like raw material's STOCK_EVENT: a carton movement is a store fact every computer reads,
-- so factory_scoped is false and the log row has no factory (009's trigger requires exactly that).
-- The log trigger takes 003's ordering lock, pg_advisory_xact_lock(777, 1), the single lock every
-- log trigger takes -- never a key of its own. 016's doorbell rings for it with no change, and
-- claim_is_current carries 018's number-block guard into this push as into every other.
--
-- Requires 009 (the log's types), 011 (lease_domains, domain_leases, lease_holds) and 006 (the
-- claim). Paste whole in the SQL editor, TEST project first. Contains revoke, which the MCP tools
-- refuse.

begin;

create table if not exists public.carton_stock_events (
  id text primary key,
  product_variant_id text not null,
  event_type text not null check (event_type in ('MANUAL_PRODUCE', 'GATEPASS_ISSUE', 'GATEPASS_CANCEL', 'MANUAL_PRODUCTION_VOID')),
  quantity integer not null check (quantity > 0),
  balance_delta integer not null,
  location_type text not null check (location_type = 'WAREHOUSE'),
  location_id text not null check (char_length(btrim(location_id)) > 0),
  created_by text,
  created_at text not null,
  manual_production_entry_id text,
  gatepass_id text,
  gatepass_line_id text,
  origin_device_id text not null,
  received_at timestamptz not null default now(),
  check (balance_delta = case when event_type in ('GATEPASS_ISSUE', 'MANUAL_PRODUCTION_VOID') then -quantity else quantity end),
  check (event_type not in ('MANUAL_PRODUCE', 'MANUAL_PRODUCTION_VOID') or manual_production_entry_id is not null),
  check (event_type not in ('GATEPASS_ISSUE', 'GATEPASS_CANCEL') or (gatepass_id is not null and gatepass_line_id is not null))
);
create index if not exists idx_carton_stock_events_variant on public.carton_stock_events (product_variant_id);
create unique index if not exists idx_carton_stock_events_entry_once
  on public.carton_stock_events (manual_production_entry_id, event_type) where manual_production_entry_id is not null;
create unique index if not exists idx_carton_stock_events_line_once
  on public.carton_stock_events (gatepass_line_id, location_id, event_type) where gatepass_line_id is not null;
alter table public.carton_stock_events enable row level security;
revoke all on table public.carton_stock_events from public, anon, authenticated;

insert into public.lease_domains (domain, note) values
  ('CARTON_STOCK', 'Every movement of the carton figure: Manual Production and its voids, gatepass issues and their cancels (026, docs/42).')
on conflict (domain) do nothing;
insert into public.domain_leases (domain) values ('CARTON_STOCK') on conflict (domain) do nothing;

insert into public.sync_aggregate_types (aggregate_type, factory_scoped, note) values
  ('CARTON_STOCK_EVENT', false, 'A carton stock movement with the change it made to the figure (026), carton lease.')
on conflict (aggregate_type) do nothing;

-- Every movement reaches the log once, with the keys the receiver reads (readCartonStockEventPayload).
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
      'gatepassLineId', new.gatepass_line_id
    ),
    new.origin_device_id,
    null
  )
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_carton_stock_events_log on public.carton_stock_events;
create trigger trg_carton_stock_events_log
after insert on public.carton_stock_events
for each row execute procedure public.log_carton_stock_event_insert();

-- One row's verdict on its shape, or null when it may be written. Never raises.
create or replace function public.carton_stock_event_problem(item jsonb) returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_quantity integer;
begin
  if item->>'id' is null or item->>'product_variant_id' is null
     or coalesce(item->>'event_type', '') not in ('MANUAL_PRODUCE', 'GATEPASS_ISSUE', 'GATEPASS_CANCEL', 'MANUAL_PRODUCTION_VOID')
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
  v_quantity := (item->>'quantity')::integer;
  if (item->>'balance_delta')::integer <> case when item->>'event_type' in ('GATEPASS_ISSUE', 'MANUAL_PRODUCTION_VOID') then -v_quantity else v_quantity end then
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
      created_by, created_at, manual_production_entry_id, gatepass_id, gatepass_line_id, origin_device_id
    ) values (
      item->>'id', item->>'product_variant_id', item->>'event_type', (item->>'quantity')::integer,
      (item->>'balance_delta')::integer, item->>'location_type', item->>'location_id', item->>'created_by',
      item->>'created_at', item->>'manual_production_entry_id', item->>'gatepass_id', item->>'gatepass_line_id',
      account.device_id
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

revoke all on function public.log_carton_stock_event_insert() from public, anon, authenticated;
revoke all on function public.carton_stock_event_problem(jsonb) from public, anon, authenticated;
revoke all on function public.push_carton_stock_event(bigint, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.push_carton_stock_event(bigint, uuid, jsonb) to authenticated;

commit;
