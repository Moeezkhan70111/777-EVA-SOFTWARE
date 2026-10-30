-- Raw-material stock movements reach the other computers, so the boss's PC shows the store's stock
-- (docs/37, the stock-screen slice, item 2).
--
-- WHAT TRAVELS. One row of the store PC's inventory_stock_events per movement, exactly as stored,
-- plus balance_delta: the change that movement made to its material's balance. The store holds two
-- sign conventions in that table (a scan out is TRANSFER_OUT with a positive quantity, a hand move
-- out is TRANSFER_OUT with a negative one), and only the store PC's own rule reads both correctly.
-- So the delta is computed there, once, and every receiver adds it. Nobody downstream re-derives a
-- sign. This table checks only that the delta is the quantity's size: the sign is the origin's.
--
-- LEASED, like label runs (012): pushed only by the computer holding RAW_MATERIAL_STORE, under the
-- epoch the movement was recorded with. Append-only: an id is one movement for good. The same id
-- with the same movement is DUPLICATE, with a different one IDENTITY_CONFLICT. The unit is not part
-- of the identity, because a unit correction on the store PC (docs/37 W.5) rewrites it.
--
-- NOT HERE YET, by decision (docs/37): the W.5 history rewrites (unit correction, a material
-- removed for good, a run erased) and packet movements. machine_program_id travels as a plain id:
-- programs do not replicate yet (W.6).
--
-- Requires 009 (the log's types), 011 (lease_holds) and 006 (the claim). Paste whole in the SQL
-- editor, TEST project first. Contains revoke, which the MCP tools refuse.

begin;

create table if not exists public.inventory_stock_events (
  id text primary key,
  item_id text not null,
  event_type text not null check (event_type in ('RECEIVE', 'ADJUST', 'CONSUME', 'TRANSFER_IN', 'TRANSFER_OUT', 'RETURN')),
  quantity double precision not null,
  unit_id text not null,
  note text,
  created_by text,
  created_at text not null,
  party_id text,
  machine_program_id text,
  balance_delta double precision not null,
  origin_device_id text not null,
  received_at timestamptz not null default now(),
  check (abs(balance_delta) = abs(quantity))
);
create index if not exists idx_inventory_stock_events_item_id on public.inventory_stock_events (item_id);
alter table public.inventory_stock_events enable row level security;
revoke all on table public.inventory_stock_events from public, anon, authenticated;

insert into public.sync_aggregate_types (aggregate_type, factory_scoped, note) values
  ('STOCK_EVENT', false, 'A raw-material stock movement with the change it made to the balance (015), store lease.')
on conflict (aggregate_type) do nothing;

-- Every movement reaches the log once, with the keys the receiver reads (readStockEventPayload).
create or replace function public.log_stock_event_insert() returns trigger
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
    'STOCK_EVENT:' || new.id,
    'STOCK_EVENT',
    new.id,
    jsonb_build_object(
      'eventId', new.id,
      'itemId', new.item_id,
      'eventType', new.event_type,
      'quantity', new.quantity,
      'unitId', new.unit_id,
      'note', new.note,
      'createdBy', new.created_by,
      'createdAt', new.created_at,
      'partyId', new.party_id,
      'machineProgramId', new.machine_program_id,
      'balanceDelta', new.balance_delta
    ),
    new.origin_device_id,
    null
  )
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_inventory_stock_events_log on public.inventory_stock_events;
create trigger trg_inventory_stock_events_log
after insert on public.inventory_stock_events
for each row execute procedure public.log_stock_event_insert();

create or replace function public.push_stock_event(p_epoch bigint, p_holder uuid, p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  account public.device_accounts%rowtype;
  item jsonb;
  existing public.inventory_stock_events%rowtype;
  v_quantity double precision;
  v_delta double precision;
  outcomes jsonb := '[]'::jsonb;
  inserted int;
begin
  account := public.claim_is_current(p_epoch, p_holder);
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'ROWS_NOT_AN_ARRAY' using errcode = '22023';
  end if;

  for item in select * from jsonb_array_elements(p_rows) loop
    if item->>'id' is null or item->>'item_id' is null or item->>'unit_id' is null
       or coalesce(item->>'event_type', '') not in ('RECEIVE', 'ADJUST', 'CONSUME', 'TRANSFER_IN', 'TRANSFER_OUT', 'RETURN')
       or jsonb_typeof(item->'quantity') is distinct from 'number'
       or jsonb_typeof(item->'balance_delta') is distinct from 'number'
       or coalesce(item->>'created_at', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'
       or coalesce(item->>'lease_epoch', '') !~ '^[0-9]{1,18}$'
       or length(coalesce(item->>'note', '')) > 2000 then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'PAYLOAD_INCOMPLETE');
      continue;
    end if;
    v_quantity := (item->>'quantity')::double precision;
    v_delta := (item->>'balance_delta')::double precision;
    if abs(v_delta) <> abs(v_quantity) then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'DELTA_DOES_NOT_MATCH');
      continue;
    end if;
    if not public.lease_holds('RAW_MATERIAL_STORE', account.device_id, (item->>'lease_epoch')::bigint) then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'NOT_LEASE_HOLDER');
      continue;
    end if;

    select * into existing from public.inventory_stock_events where id = item->>'id';
    if found then
      if existing.item_id = item->>'item_id'
         and existing.event_type = item->>'event_type'
         and existing.quantity = v_quantity
         and existing.created_at = item->>'created_at' then
        outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'DUPLICATE');
      else
        outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'IDENTITY_CONFLICT');
      end if;
      continue;
    end if;

    insert into public.inventory_stock_events (
      id, item_id, event_type, quantity, unit_id, note, created_by, created_at,
      party_id, machine_program_id, balance_delta, origin_device_id
    ) values (
      item->>'id', item->>'item_id', item->>'event_type', v_quantity, item->>'unit_id', item->>'note',
      item->>'created_by', item->>'created_at', item->>'party_id', item->>'machine_program_id', v_delta,
      account.device_id
    )
    on conflict (id) do nothing;
    get diagnostics inserted = row_count;
    if inserted > 0 then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'INSERTED');
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'epoch', account.claim_epoch, 'results', outcomes);
end;
$$;

revoke all on function public.log_stock_event_insert() from public, anon, authenticated;
revoke all on function public.push_stock_event(bigint, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.push_stock_event(bigint, uuid, jsonb) to authenticated;

commit;
