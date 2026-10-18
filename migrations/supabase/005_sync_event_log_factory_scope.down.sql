-- Puts the event log back the way migration 003 and 004 left it.
--
-- REVERSING THIS RE-OPENS THE CROSS-FACTORY READ. After this file runs, any enrolled device can
-- select every row of sync_event_log again, including another factory's PRODUCED events with
-- their operator, station and article snapshots. Run it only to undo a failed apply on a project
-- that is not yet carrying more than one factory.
--
-- The order is the reverse of the up file: the policy stops depending on the column before the
-- column goes, and the trigger stops writing it before the constraint that requires it is
-- dropped. The labels themselves disappear with the column, so re-applying 005 afterwards
-- backfills them again from production_events.

begin;

-- ── The policy stops using the column ──
--
-- Exactly as 004 wrote it.

drop policy if exists device_reads_sync_event_log on sync_event_log;
create policy device_reads_sync_event_log on sync_event_log
for select to authenticated
using (is_enrolled_device());

-- ── The trigger stops writing it ──
--
-- The body 003 installed, restored in full.

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

  insert into public.sync_event_log (dedupe_key, aggregate_type, aggregate_id, payload, origin_device_id)
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
    new.device_id
  )
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;

-- ── Then the column and everything that guarded it ──

alter table sync_event_log drop constraint if exists sync_event_log_factory_scope;
drop index if exists idx_sync_event_log_factory_seq;
alter table sync_event_log drop column if exists factory_id;

commit;
