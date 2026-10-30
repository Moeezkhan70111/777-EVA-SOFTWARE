-- Leased records: master data reaches the cloud as whole records, replaced by revision.
--
-- THE RULE (docs/37 section W, Class D as superseded). A record of a leased domain has one writer,
-- the lease holder. Its revision of the record replaces every reader's copy, whole. No merge, no
-- last-write-wins on a clock, no field-by-field rule: with one writer there is nothing to merge.
--
-- ONE GENERIC STORE, NOT A MIRROR PER TABLE. Master data is 13 local tables (docs/37 W.1), and
-- several are documents -- an item with its values and unit steps, a category with its fields and
-- options, a ladder preset with its steps -- which must replace as one, never row by row. So the
-- unit here is the RECORD: one row per (type, id), carrying the holder's whole document as JSON.
-- The cloud judges the envelope, not the body:
--   * the type is known, and belongs to a leased domain
--   * the pushing device holds that domain's lease, under the epoch the record was written under
--   * the revision only ever moves forward
-- The receiving computer validates the body, as it does every contract's payload (R25), against
-- its own schema. A typed mirror of each table would have to change in step with every local
-- migration that touches master data, for no check the receiver does not already make.
--
-- MILESTONE 2 REUSES IT. Documents and approvals are leased records too: a gatepass with its lines
-- is one record. Adding them is a row in leased_record_types, not a new migration of this shape.
--
-- REVISIONS. A positive integer per record, raised by the holder on every change. Monotonic by
-- construction under one writer, and across a handover because the new holder has pulled past the
-- old holder's last write before it may write (011's barrier). So:
--   newer than the cloud's    UPDATED (or INSERTED for a first revision), and logged
--   the same, same content    DUPLICATE, acknowledged
--   the same, other content   REVISION_CONFLICT, refused and visible: two different records under
--                             one revision means two writers, which the lease exists to prevent
--   older than the cloud's    SUPERSEDED, acknowledged: a retry of a revision the cloud has
--                             already replaced. Accepting it as current would roll the record back.
-- A deletion is a revision too (deleted = true, no body), so a reader learns of it in order.
--
-- EVERY REVISION IS LOGGED, as its own event (dedupe key TYPE:id:revision), so a reader that
-- applies the log in order ends at the latest revision, and one that missed a revision still
-- converges on the next. Unscoped, like every master-data type: there is one factory.
--
-- NO CLIENT READS THE TABLE. Computers learn of records from sync_event_log. RLS on, no policy,
-- no grant: only push_leased_record and its trigger touch it.
--
-- Requires 009 (types are rows) and 011 (the lease).
-- Paste whole in the SQL editor, TEST project first. Contains revoke, which the MCP tools refuse.

begin;

-- ── Which record types exist, and whose lease each one is under ──

insert into public.sync_aggregate_types (aggregate_type, factory_scoped, note) values
  ('PARTY_GROUP', false, 'A party group: a leased record (013), master data.'),
  ('PARTY', false, 'A party -- supplier, contractor, customer: a leased record (013), master data.'),
  ('INVENTORY_UNIT', false, 'A unit of measure: a leased record (013), master data.'),
  ('UNIT_LADDER_PRESET', false, 'A unit ladder preset with its steps: a leased record (013), master data.'),
  ('INVENTORY_CATEGORY', false, 'A material category with its fields and their options: a leased record (013), master data.'),
  ('INVENTORY_ITEM', false, 'A material with its field values and unit steps: a leased record (013), master data.'),
  ('WORK_SECTION', false, 'A work section: a leased record (013), master data.'),
  ('MACHINE', false, 'A machine: a leased record (013), master data.')
on conflict (aggregate_type) do nothing;

create table if not exists public.leased_record_types (
  aggregate_type text primary key references public.sync_aggregate_types (aggregate_type),
  lease_domain text not null references public.lease_domains (domain)
);
alter table public.leased_record_types enable row level security;
revoke all on table public.leased_record_types from public, anon, authenticated;

insert into public.leased_record_types (aggregate_type, lease_domain) values
  ('PARTY_GROUP', 'MASTER_DATA'),
  ('PARTY', 'MASTER_DATA'),
  ('INVENTORY_UNIT', 'MASTER_DATA'),
  ('UNIT_LADDER_PRESET', 'MASTER_DATA'),
  ('INVENTORY_CATEGORY', 'MASTER_DATA'),
  ('INVENTORY_ITEM', 'MASTER_DATA'),
  ('WORK_SECTION', 'MASTER_DATA'),
  ('MACHINE', 'MASTER_DATA')
on conflict (aggregate_type) do nothing;

-- ── The current revision of every record ──

create table if not exists public.leased_records (
  aggregate_type text not null references public.leased_record_types (aggregate_type),
  record_id text not null,
  revision bigint not null check (revision > 0),
  deleted boolean not null default false,
  -- The holder's whole record. Null only for a deletion.
  body jsonb,
  -- The device and lease epoch that wrote this revision, proven by the claim and the lease.
  origin_device_id text not null,
  lease_epoch bigint not null,
  received_at timestamptz not null default now(),
  primary key (aggregate_type, record_id),
  check (deleted = (body is null)),
  check (body is null or jsonb_typeof(body) = 'object')
);
alter table public.leased_records enable row level security;
revoke all on table public.leased_records from public, anon, authenticated;

-- ── Every revision, logged ──

create or replace function public.log_leased_record_revision() returns trigger
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
    new.aggregate_type || ':' || new.record_id || ':' || new.revision::text,
    new.aggregate_type,
    new.record_id,
    jsonb_build_object(
      'recordId', new.record_id,
      'revision', new.revision,
      'deleted', new.deleted,
      'body', new.body
    ),
    new.origin_device_id,
    null
  )
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_leased_records_log on public.leased_records;
create trigger trg_leased_records_log
after insert or update of revision on public.leased_records
for each row execute procedure public.log_leased_record_revision();

-- ── Pushing revisions ──

create or replace function public.push_leased_record(p_epoch bigint, p_holder uuid, p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  account public.device_accounts%rowtype;
  item jsonb;
  v_domain text;
  existing public.leased_records%rowtype;
  v_revision bigint;
  v_deleted boolean;
  v_body jsonb;
  outcomes jsonb := '[]'::jsonb;
  inserted int;
begin
  account := public.claim_is_current(p_epoch, p_holder);

  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'ROWS_NOT_AN_ARRAY' using errcode = '22023';
  end if;

  for item in select * from jsonb_array_elements(p_rows) loop
    -- Every cast below runs only on text these patterns have approved, so none can raise. The
    -- answer names the record by type and id, because an id alone is not unique across types.
    if item->>'aggregate_type' is null or item->>'record_id' is null
       or coalesce(item->>'revision', '') !~ '^[1-9][0-9]{0,17}$'
       or coalesce(item->>'lease_epoch', '') !~ '^[0-9]{1,18}$'
       or jsonb_typeof(item->'deleted') is distinct from 'boolean' then
      outcomes := outcomes || jsonb_build_object('aggregate_type', item->>'aggregate_type', 'record_id', item->>'record_id',
        'outcome', 'REFUSED', 'reason', 'PAYLOAD_INCOMPLETE');
      continue;
    end if;
    v_revision := (item->>'revision')::bigint;
    v_deleted := (item->>'deleted')::boolean;
    v_body := case when v_deleted then null else item->'body' end;

    -- A deletion carries no body. Anything else carries one object, of a bounded size.
    if (not v_deleted and jsonb_typeof(v_body) is distinct from 'object') then
      outcomes := outcomes || jsonb_build_object('aggregate_type', item->>'aggregate_type', 'record_id', item->>'record_id',
        'outcome', 'REFUSED', 'reason', 'PAYLOAD_INCOMPLETE');
      continue;
    end if;
    if v_body is not null and octet_length(v_body::text) > 262144 then
      outcomes := outcomes || jsonb_build_object('aggregate_type', item->>'aggregate_type', 'record_id', item->>'record_id',
        'outcome', 'REFUSED', 'reason', 'RECORD_TOO_LARGE');
      continue;
    end if;

    select t.lease_domain into v_domain from public.leased_record_types t where t.aggregate_type = item->>'aggregate_type';
    if not found then
      outcomes := outcomes || jsonb_build_object('aggregate_type', item->>'aggregate_type', 'record_id', item->>'record_id',
        'outcome', 'REFUSED', 'reason', 'UNKNOWN_RECORD_TYPE');
      continue;
    end if;

    if not public.lease_holds(v_domain, account.device_id, (item->>'lease_epoch')::bigint) then
      outcomes := outcomes || jsonb_build_object('aggregate_type', item->>'aggregate_type', 'record_id', item->>'record_id',
        'outcome', 'REFUSED', 'reason', 'NOT_LEASE_HOLDER');
      continue;
    end if;

    -- Locked, so two pushes of one record cannot both read the old revision and both write.
    select * into existing from public.leased_records r
     where r.aggregate_type = item->>'aggregate_type' and r.record_id = item->>'record_id'
     for update;

    if not found then
      insert into public.leased_records (aggregate_type, record_id, revision, deleted, body, origin_device_id, lease_epoch)
      values (item->>'aggregate_type', item->>'record_id', v_revision, v_deleted, v_body, account.device_id,
              (item->>'lease_epoch')::bigint)
      on conflict (aggregate_type, record_id) do nothing;
      -- Lost a race to insert the same record: no answer, so the next push meets the stored row.
      get diagnostics inserted = row_count;
      if inserted > 0 then
        outcomes := outcomes || jsonb_build_object('aggregate_type', item->>'aggregate_type', 'record_id', item->>'record_id',
          'outcome', 'INSERTED');
      end if;
      continue;
    end if;

    if v_revision < existing.revision then
      outcomes := outcomes || jsonb_build_object('aggregate_type', item->>'aggregate_type', 'record_id', item->>'record_id',
        'outcome', 'SUPERSEDED');
    elsif v_revision = existing.revision then
      if existing.deleted = v_deleted and existing.body is not distinct from v_body then
        outcomes := outcomes || jsonb_build_object('aggregate_type', item->>'aggregate_type', 'record_id', item->>'record_id',
          'outcome', 'DUPLICATE');
      else
        outcomes := outcomes || jsonb_build_object('aggregate_type', item->>'aggregate_type', 'record_id', item->>'record_id',
          'outcome', 'REFUSED', 'reason', 'REVISION_CONFLICT');
      end if;
    else
      update public.leased_records r
         set revision = v_revision, deleted = v_deleted,
             body = v_body, origin_device_id = account.device_id,
             lease_epoch = (item->>'lease_epoch')::bigint, received_at = now()
       where r.aggregate_type = item->>'aggregate_type' and r.record_id = item->>'record_id';
      outcomes := outcomes || jsonb_build_object('aggregate_type', item->>'aggregate_type', 'record_id', item->>'record_id',
        'outcome', 'UPDATED');
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'epoch', account.claim_epoch, 'results', outcomes);
end;
$$;

-- ── Who may call what ──
--
-- After the trigger exists: EXECUTE is checked when a trigger is created. The trigger function goes
-- to nobody, the push back to authenticated only, which checks the claim and the lease itself.

revoke all on function public.log_leased_record_revision() from public, anon, authenticated;
revoke all on function public.push_leased_record(bigint, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.push_leased_record(bigint, uuid, jsonb) to authenticated;

commit;
