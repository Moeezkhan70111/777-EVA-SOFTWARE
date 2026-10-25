-- Raw-material label runs and packets reach the cloud, from the computer that holds the store.
--
-- WHAT THIS ADDS. Two mirror tables, two log triggers and two push RPCs, for the two events the
-- local sender already queues (packages/data/src/database/syncEvents.ts):
--   RAW_MATERIAL_QR_BATCH  one label run: which supplier, which material, which serials
--   RAW_MATERIAL_QR        one packet's identity: its run, its serial, what one packet holds
-- The receiving half is packages/sync/src/rawMaterialContracts.ts, and the log payloads below are
-- built to be read by readRawMaterialQrBatchPayload and readRawMaterialQrPayload exactly.
--
-- LEASED (docs/37 W.1). Label runs belong to RAW_MATERIAL_STORE: the serial counter is per supplier
-- and material, so two computers printing at once would print the same serials. Every row must
-- carry the lease epoch it was written under, and is refused NOT_LEASE_HOLDER unless that is still
-- this device's lease (lease_holds, 011). Unlike cartons, which stay multi-writer.
--
-- THE CLOUD IS A RELAY HERE, NOT A JUDGE OF MASTER DATA. There is no foreign key to parties,
-- materials or units: none of them is in the cloud yet (stage 2c), and when they are, a run must
-- still not be refused because its supplier's row is a pass behind. The receiving computer waits
-- for missing master data and parks the event meanwhile (owner decision, "wait for it"). What the
-- cloud DOES judge is everything inside the event itself: a run whose serials do not add up, a
-- packet outside its run, a serial already printed under another id.
--
-- IDENTITY IS FOR ALL TIME. A run or packet that arrives again with the same content is DUPLICATE,
-- acknowledged. The same id with different content is IDENTITY_CONFLICT, refused and visible --
-- never merged and never overwritten. That is the case docs/37 W.5 describes: a run erased and its
-- serials re-printed, which the history rewrite work deals with on the sending side.
--
-- TIMES ARE TEXT, as 002 made them for cartons: created_at is the origin's ISO instant, kept
-- byte for byte, so the receiver's identity comparison sees exactly what was sent. received_at is
-- the cloud's own clock, for diagnostics only.
--
-- NO CLIENT READS THE MIRRORS. Computers learn of runs and packets from sync_event_log. The two
-- tables have RLS on, no policy and no grant: only the push RPCs and their triggers touch them.
--
-- EVERY REFUSAL IS PER ROW, as in 008: nothing in a loop raises, so one bad row cannot stall the
-- rows beside it, and the casts only run on text a pattern has already approved.
--
-- Requires 009 (the two types are rows in sync_aggregate_types) and 011 (lease_holds).
-- Paste whole in the SQL editor, TEST project first. Contains revoke, which the MCP tools refuse.

begin;

-- ── The mirrors ──

create table if not exists public.raw_material_qr_batches (
  id text primary key,
  party_id text not null,
  item_id text not null,
  start_sequence integer not null check (start_sequence > 0),
  end_sequence integer not null,
  quantity integer not null check (quantity > 0),
  created_at text not null,
  created_by text,
  requested_by text,
  origin_device_id text not null,
  received_at timestamptz not null default now(),
  check (end_sequence - start_sequence + 1 = quantity)
);
alter table public.raw_material_qr_batches enable row level security;
revoke all on table public.raw_material_qr_batches from public, anon, authenticated;

create table if not exists public.raw_material_qrs (
  id text primary key,
  batch_id text not null references public.raw_material_qr_batches (id),
  party_id text not null,
  item_id text not null,
  sequence integer not null check (sequence > 0),
  -- What one packet holds, in packing_unit_id. Both, or neither on a packet printed before
  -- packing existed. double precision, because the local column is REAL and must round-trip.
  packing_quantity double precision check (packing_quantity > 0),
  packing_unit_id text,
  created_at text not null,
  origin_device_id text not null,
  received_at timestamptz not null default now(),
  unique (party_id, item_id, sequence),
  check ((packing_quantity is null) = (packing_unit_id is null))
);
create index if not exists idx_raw_material_qrs_batch_id on public.raw_material_qrs (batch_id);
alter table public.raw_material_qrs enable row level security;
revoke all on table public.raw_material_qrs from public, anon, authenticated;

-- ── The log ──
--
-- Same pattern as 003 and 005: the advisory lock first, so log positions are handed out in commit
-- order, and on conflict do nothing, so a repeat takes no second position. factory_id is null:
-- both types are seeded unscoped in 009, and the scope trigger enforces exactly that.

create or replace function public.log_raw_material_qr_batch_insert() returns trigger
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
    'RAW_MATERIAL_QR_BATCH:' || new.id,
    'RAW_MATERIAL_QR_BATCH',
    new.id,
    jsonb_build_object(
      'batchId', new.id,
      'partyId', new.party_id,
      'itemId', new.item_id,
      'startSequence', new.start_sequence,
      'endSequence', new.end_sequence,
      'quantity', new.quantity,
      'createdAt', new.created_at,
      'createdBy', new.created_by,
      'requestedBy', new.requested_by
    ),
    new.origin_device_id,
    null
  )
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;

create or replace function public.log_raw_material_qr_insert() returns trigger
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
    'RAW_MATERIAL_QR:' || new.id,
    'RAW_MATERIAL_QR',
    new.id,
    jsonb_build_object(
      'qrId', new.id,
      'batchId', new.batch_id,
      'partyId', new.party_id,
      'itemId', new.item_id,
      'sequence', new.sequence,
      'packingQuantity', new.packing_quantity,
      'packingUnitId', new.packing_unit_id,
      'createdAt', new.created_at
    ),
    new.origin_device_id,
    null
  )
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_raw_material_qr_batches_log on public.raw_material_qr_batches;
create trigger trg_raw_material_qr_batches_log
after insert on public.raw_material_qr_batches
for each row execute procedure public.log_raw_material_qr_batch_insert();

drop trigger if exists trg_raw_material_qrs_log on public.raw_material_qrs;
create trigger trg_raw_material_qrs_log
after insert on public.raw_material_qrs
for each row execute procedure public.log_raw_material_qr_insert();

-- ── Pushing a label run ──

create or replace function public.push_raw_material_qr_batch(p_epoch bigint, p_holder uuid, p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  account public.device_accounts%rowtype;
  item jsonb;
  existing public.raw_material_qr_batches%rowtype;
  outcomes jsonb := '[]'::jsonb;
  inserted int;
begin
  account := public.claim_is_current(p_epoch, p_holder);

  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'ROWS_NOT_AN_ARRAY' using errcode = '22023';
  end if;

  for item in select * from jsonb_array_elements(p_rows) loop
    -- Every cast below runs only on text these patterns have approved, so none can raise.
    if item->>'id' is null or item->>'party_id' is null or item->>'item_id' is null
       or coalesce(item->>'start_sequence', '') !~ '^[1-9][0-9]{0,8}$'
       or coalesce(item->>'end_sequence', '') !~ '^[1-9][0-9]{0,8}$'
       or coalesce(item->>'quantity', '') !~ '^[1-9][0-9]{0,8}$'
       or coalesce(item->>'created_at', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'
       or coalesce(item->>'lease_epoch', '') !~ '^[0-9]{1,18}$' then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'PAYLOAD_INCOMPLETE');
      continue;
    end if;

    if not public.lease_holds('RAW_MATERIAL_STORE', account.device_id, (item->>'lease_epoch')::bigint) then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'NOT_LEASE_HOLDER');
      continue;
    end if;

    -- A run whose serials do not add up is a broken record, not one to repair.
    if (item->>'end_sequence')::int - (item->>'start_sequence')::int + 1 <> (item->>'quantity')::int then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'RUN_DOES_NOT_ADD_UP');
      continue;
    end if;

    select * into existing from public.raw_material_qr_batches where id = item->>'id';
    if found then
      if existing.party_id = item->>'party_id'
         and existing.item_id = item->>'item_id'
         and existing.start_sequence = (item->>'start_sequence')::int
         and existing.end_sequence = (item->>'end_sequence')::int
         and existing.created_at = item->>'created_at' then
        outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'DUPLICATE');
      else
        outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'IDENTITY_CONFLICT');
      end if;
      continue;
    end if;

    insert into public.raw_material_qr_batches (
      id, party_id, item_id, start_sequence, end_sequence, quantity,
      created_at, created_by, requested_by, origin_device_id
    ) values (
      item->>'id', item->>'party_id', item->>'item_id',
      (item->>'start_sequence')::int, (item->>'end_sequence')::int, (item->>'quantity')::int,
      item->>'created_at', item->>'created_by', item->>'requested_by', account.device_id
    )
    on conflict (id) do nothing;

    -- Lost a race with the same id: the next push answers it properly, against the stored row.
    get diagnostics inserted = row_count;
    if inserted > 0 then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'INSERTED');
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'epoch', account.claim_epoch, 'results', outcomes);
end;
$$;

-- ── Pushing a packet ──

create or replace function public.push_raw_material_qr(p_epoch bigint, p_holder uuid, p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  account public.device_accounts%rowtype;
  item jsonb;
  run public.raw_material_qr_batches%rowtype;
  existing public.raw_material_qrs%rowtype;
  packing double precision;
  outcomes jsonb := '[]'::jsonb;
  inserted int;
begin
  account := public.claim_is_current(p_epoch, p_holder);

  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'ROWS_NOT_AN_ARRAY' using errcode = '22023';
  end if;

  for item in select * from jsonb_array_elements(p_rows) loop
    -- Packing travels as a pair: both present, or both absent on an old packet.
    if item->>'id' is null or item->>'batch_id' is null or item->>'party_id' is null or item->>'item_id' is null
       or coalesce(item->>'sequence', '') !~ '^[1-9][0-9]{0,8}$'
       or coalesce(item->>'created_at', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'
       or coalesce(item->>'lease_epoch', '') !~ '^[0-9]{1,18}$'
       or (item->>'packing_quantity' is null) <> (item->>'packing_unit_id' is null)
       or (item->>'packing_quantity' is not null and jsonb_typeof(item->'packing_quantity') <> 'number') then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'PAYLOAD_INCOMPLETE');
      continue;
    end if;
    packing := (item->>'packing_quantity')::double precision;
    if packing is not null and not (packing > 0) then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'PAYLOAD_INCOMPLETE');
      continue;
    end if;

    if not public.lease_holds('RAW_MATERIAL_STORE', account.device_id, (item->>'lease_epoch')::bigint) then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'NOT_LEASE_HOLDER');
      continue;
    end if;

    -- The run first. Not here YET is a prerequisite, not a fault: the sender orders runs before
    -- packets, and the client reads this reason as "wait", as it reads QR_NOT_REGISTERED_YET.
    select * into run from public.raw_material_qr_batches where id = item->>'batch_id';
    if not found then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'RUN_NOT_REGISTERED_YET');
      continue;
    end if;
    if run.party_id <> item->>'party_id' or run.item_id <> item->>'item_id'
       or (item->>'sequence')::int not between run.start_sequence and run.end_sequence then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'PACKET_OUTSIDE_ITS_RUN');
      continue;
    end if;

    select * into existing from public.raw_material_qrs where id = item->>'id';
    if found then
      if existing.batch_id = item->>'batch_id'
         and existing.sequence = (item->>'sequence')::int
         and existing.packing_quantity is not distinct from packing
         and existing.packing_unit_id is not distinct from item->>'packing_unit_id'
         and existing.created_at = item->>'created_at' then
        outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'DUPLICATE');
      else
        outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'IDENTITY_CONFLICT');
      end if;
      continue;
    end if;

    -- The same serial printed under another id. Named, because two packets would carry one label.
    if exists (
      select 1 from public.raw_material_qrs other
       where other.party_id = item->>'party_id' and other.item_id = item->>'item_id'
         and other.sequence = (item->>'sequence')::int
    ) then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'SERIAL_CLASH');
      continue;
    end if;

    begin
      insert into public.raw_material_qrs (
        id, batch_id, party_id, item_id, sequence, packing_quantity, packing_unit_id,
        created_at, origin_device_id
      ) values (
        item->>'id', item->>'batch_id', item->>'party_id', item->>'item_id', (item->>'sequence')::int,
        packing, item->>'packing_unit_id', item->>'created_at', account.device_id
      )
      on conflict (id) do nothing;
      get diagnostics inserted = row_count;
      if inserted > 0 then
        outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'INSERTED');
      end if;
    exception
      when unique_violation then
        -- Lost the race on the serial. Same answer as the pre-check.
        outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'SERIAL_CLASH');
    end;
  end loop;

  return jsonb_build_object('ok', true, 'epoch', account.claim_epoch, 'results', outcomes);
end;
$$;

-- ── Who may call what ──
--
-- After the triggers exist: EXECUTE is checked when a trigger is created. The trigger functions go
-- to nobody. The two pushes go back to authenticated only, and check the claim and the lease
-- themselves.

revoke all on function public.log_raw_material_qr_batch_insert() from public, anon, authenticated;
revoke all on function public.log_raw_material_qr_insert() from public, anon, authenticated;
revoke all on function public.push_raw_material_qr_batch(bigint, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.push_raw_material_qr(bigint, uuid, jsonb) from public, anon, authenticated;

grant execute on function public.push_raw_material_qr_batch(bigint, uuid, jsonb) to authenticated;
grant execute on function public.push_raw_material_qr(bigint, uuid, jsonb) to authenticated;

commit;
