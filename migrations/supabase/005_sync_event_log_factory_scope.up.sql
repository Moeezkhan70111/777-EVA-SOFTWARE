-- The event log stops being readable across factories.
--
-- THE DEFECT. Migration 004 scopes a direct read of production_events to the caller's factory:
--
--     using (factory_id = current_factory_id())
--
-- but scopes the log that CARRIES those same events to nothing more than enrolment:
--
--     using (is_enrolled_device())
--
-- So the log is a way round the policy. A device enrolled for one factory could select from
-- sync_event_log and read another factory's PRODUCED events in full: the payload carries
-- factoryId, workstationId, operatorId and the article, colour, size and serial snapshots. The
-- table it could not read directly, it could read through its own change feed.
--
-- WHY NOT A POLICY-ONLY FIX. There is nothing on a log row to scope by. `payload->>'factoryId'`
-- is the only factory in sight and it arrives inside a client-supplied document; a policy built
-- on it would be enforcing whatever the writer put there. So the association is made a real
-- column, written by the trigger from production_events.factory_id -- the row's OWN column,
-- which 004's insert policy already requires to equal current_factory_id() -- and a check
-- constraint makes it structurally impossible for a production event to be logged without one.
--
-- QR_MASTER IS DELIBERATELY NOT SCOPED, and the NULL says so rather than hiding it.
--
--   A carton identity has no factory anywhere in the model: neither qr_master nor
--   product_variants has a tenant column, and 004 says as much in its own header -- a second
--   factory needs a schema change there, not a policy change. Writing current_factory_id() onto
--   the log row would invent an ownership the carton itself does not have, and would then be
--   believed. The honest position is that these rows are global, exactly as the qr_master table
--   they describe is global: scoping the log while the table stays open to every enrolled device
--   would protect nothing.
--
--   CONFIRMED BY THE OWNER, 2026-10-17, after the alternative was put to them: scoping carton
--   identities would mean giving qr_master (and product_variants) a tenant column of their own,
--   backfilling it, and scoping both tables as well as the log. That is a change to the carton
--   identity itself and to the push payload, and it is not being made. One factory, one set of
--   carton identities. Revisit only if 777 ever runs a second factory in one project.
--
--   The check constraint below makes that explicit and enforceable: a QR_MASTER row MUST have a
--   null factory, a PRODUCTION_PRODUCED row MUST have one. A null is then a stated decision
--   about carton identities, never a production event that slipped through unlabelled.
--
-- ORDER AND CURSORS ARE UNCHANGED. seq is still a bigserial taken under the same advisory lock,
-- and the log is still append-only. A device now sees a sparse run of positions -- the gaps are
-- another factory's events -- and the puller already handles gaps: it advances its cursor over
-- the settled prefix of what it FETCHED, so a position it never sees is never waited for.
--
-- THE BACKFILL takes production_events.factory_id by joining on aggregate_id, never the payload.
-- The append-only trigger is switched off around it and straight back on: this is the one write
-- to history the log will ever take, it adds a label to existing rows rather than changing what
-- any of them says, and it happens before any policy depends on the column.
--
-- IF THE BACKFILL CANNOT LABEL A ROW the check constraint below refuses and the whole migration
-- rolls back, which is the right outcome: a PRODUCTION_PRODUCED entry with no matching
-- production_events row cannot be proved to belong to anyone, and must not be guessed at. Find
-- out why that row exists before running this again.
--
-- Requires the table owner (the Supabase SQL editor runs as one) for ALTER TABLE ... TRIGGER.

begin;

-- ── The association ──

alter table sync_event_log add column if not exists factory_id text references factories(id);

-- ── Label what is already there ──

alter table sync_event_log disable trigger trg_sync_event_log_immutable;

update sync_event_log as log
   set factory_id = events.factory_id
  from production_events as events
 where events.id = log.aggregate_id
   and log.aggregate_type = 'PRODUCTION_PRODUCED'
   and log.factory_id is null;

alter table sync_event_log enable trigger trg_sync_event_log_immutable;

-- ── And make it impossible to be missing ──

alter table sync_event_log drop constraint if exists sync_event_log_factory_scope;
alter table sync_event_log add constraint sync_event_log_factory_scope check (
  (aggregate_type = 'PRODUCTION_PRODUCED' and factory_id is not null)
  or (aggregate_type = 'QR_MASTER' and factory_id is null)
);

-- Every read is now filtered by factory before it is ordered by position.
create index if not exists idx_sync_event_log_factory_seq on sync_event_log(factory_id, seq);

-- ── The trigger writes it ──
--
-- new.factory_id, not current_factory_id(): the log row describes that event, and the event
-- names its own factory. 004's insert policy already requires a device to write only its own
-- factory, so the column is trustworthy at the moment it is copied -- and an owner-made
-- correction applied outside RLS stays labelled with the factory it actually belongs to rather
-- than with whoever was signed in.

create or replace function public.log_production_produced_insert() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.event_type <> 'PRODUCED' then
    return new;
  end if;

  perform pg_advisory_xact_lock(777, 1);

  insert into public.sync_event_log (
    dedupe_key, aggregate_type, aggregate_id, payload, origin_device_id, factory_id
  )
  values (
    'PRODUCTION_PRODUCED:' || new.id,
    'PRODUCTION_PRODUCED',
    new.id,
    jsonb_build_object(
      'eventId', new.id,
      'qrId', new.qr_id,
      'productVariantId', new.product_variant_id,
      'occurredAt', new.event_ts_local,
      'eventDate', new.event_date,
      'eventHour', new.event_hour::int,
      'factoryId', new.factory_id,
      'workstationId', new.workstation_id,
      'operatorId', new.operator_id,
      'deviceId', new.device_id,
      'article', new.article_snapshot,
      'color', new.color_snapshot,
      'size', new.size_snapshot,
      'serial', new.serial_snapshot,
      'metadataJson', coalesce(new.metadata_json, ''),
      'createdAt', new.created_at,
      'sourceApp', new.source_app
    ),
    new.device_id,
    new.factory_id
  )
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;

-- ── The policy enforces it ──

drop policy if exists device_reads_sync_event_log on sync_event_log;
create policy device_reads_sync_event_log on sync_event_log
for select to authenticated
using (
  is_enrolled_device()
  and (
    factory_id = current_factory_id()
    or (factory_id is null and aggregate_type = 'QR_MASTER')
  )
);

commit;
