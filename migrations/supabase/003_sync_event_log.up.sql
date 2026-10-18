-- The ordered log a second computer reads to catch up.
--
-- Pushing alone only empties one computer's queue. To see what another computer recorded, a
-- computer needs an ordered list it can read from a remembered position — which is what
-- packages/sync's SyncPull points its cursor into.
--
-- THE LOG IS WRITTEN BY TRIGGERS, NOT BY CLIENTS. A device inserts the business row and nothing
-- else; the log entry is derived from the row that was just written. That matters for three
-- reasons:
--
--   * a device cannot forge an entry, or claim an event the database does not actually hold
--   * the payload cannot drift from the row, because it is built from the row
--   * the log needs no insert permission for anyone, so it can be read-only to every device
--
-- ORDERING, AND THE RACE THAT MAKES IT HARD.
--
-- A bigserial position is handed out by nextval() when the row is INSERTED, but the row only
-- becomes visible when its transaction COMMITS. Those two orders are not the same, and a reader
-- that walks `seq > cursor` can be ruined by the difference:
--
--   tx A inserts, gets seq 5, and is slow to commit
--   tx B inserts, gets seq 6, and commits
--   the reader sees 6, applies it, and moves its cursor to 6
--   tx A commits -- seq 5 is now visible, but 5 is not > 6, so it is NEVER read
--
-- That is silent, permanent loss of a committed business event on the receiving computer.
--
-- WHY THE SNAPSHOT WATERMARK DOES NOT FIX IT. The usual suggestion is to read only rows whose
-- inserting transaction has finished: `xmin < pg_snapshot_xmin(pg_current_snapshot())`. It looks
-- right and it is not, because a transaction's id and its sequence position are allocated at
-- different moments. A transaction takes its xid at its FIRST write, and calls nextval() here
-- whenever it happens to reach this trigger, so a transaction with a HIGHER xid can hold a LOWER
-- seq:
--
--   tx A takes xid 100 on an earlier write, reaches this trigger later, gets seq 6
--   tx B takes xid 101, reaches this trigger at once, gets seq 5, and is slow to commit
--   A commits. The lowest running xid is now 101, so the watermark is 101
--   A's row has xmin 100 < 101, so the reader consumes seq 6 and moves its cursor to 6
--   B commits -- seq 5 is lost, exactly as before
--
-- The watermark would only work if seq order always matched xid order, and nothing makes it.
-- There is also a 32-bit problem underneath: a row's xmin system column is a plain xid, while
-- pg_snapshot_xmin returns a 64-bit full xid, so the comparison stops being meaningful after
-- transaction id wraparound.
--
-- WHAT THIS DOES INSTEAD. The trigger takes a transaction-level advisory lock before it inserts,
-- so only one transaction at a time can be between "take a position" and "commit". A later
-- position therefore cannot exist until the previous writer has committed or rolled back, which
-- makes seq order and commit order the same thing for every row that survives.
--
-- The reader's rule `seq > cursor order by seq` is then correct with no watermark and no gap
-- detection: if seq 6 is visible, seq 5 has already been settled -- committed and visible, or
-- rolled back and never coming. A rolled-back transaction leaves a permanent hole, because
-- sequences do not roll back, and a hole is harmless precisely because nothing can arrive in it
-- later.
--
-- COST. Log writers serialise for the remainder of their transaction. This is a handful of
-- computers recording scans, so the contention is nil, and correctness is not negotiable here.
-- The lock is transaction-scoped, so it is released on commit and on rollback without anything
-- having to remember to unlock, and it is the only advisory lock in the system, so it cannot
-- take part in a deadlock cycle.
--
-- IDEMPOTENCY. dedupe_key is unique and built exactly as @erp/data's syncEvents.ts builds it, so
-- the same business event can never take two positions in the log however many times it is
-- pushed. The insert itself is made idempotent by the primary keys of qr_master and
-- production_events plus PostgREST's resolution=ignore-duplicates, so a retried push is a no-op
-- and the trigger does not fire a second time.
--
-- THE PAYLOAD KEYS ARE THE CONTRACT. They must match readQrMasterPayload and
-- readProductionProducedPayload in packages/data/src/database/syncEvents.ts exactly. eventHour is
-- built as a number, not a string, because the reader refuses anything else.

begin;

create table if not exists sync_event_log (
  seq bigserial primary key,
  -- Exactly the key the local outbox uses, so the same event is the same event on both sides.
  dedupe_key text not null unique,
  aggregate_type text not null check (aggregate_type in ('QR_MASTER','PRODUCTION_PRODUCED')),
  aggregate_id text not null,
  operation text not null default 'INSERT' check (operation in ('INSERT')),
  payload jsonb not null,
  -- Which installation recorded it. For tracing only: never used to decide a winner.
  origin_device_id text,
  -- When the cloud learned of it. The business times live inside the payload.
  logged_at timestamptz not null default now()
);

create index if not exists idx_sync_event_log_seq on sync_event_log(seq);

-- RLS ON, FROM THE MOMENT THE TABLE EXISTS. Supabase grants every privilege on a new table in
-- the public schema to anon and authenticated by default, so a table created with RLS off is
-- readable by anyone who can authenticate. Migration 004 defines the policy that decides which
-- rows -- and a policy on a table whose RLS is off does nothing at all, which would have left the
-- whole event history open to any account in the project.
alter table sync_event_log enable row level security;

-- ── QR_MASTER: one carton's identity ──

-- The search path is EMPTY, not 'public'. Pinning it to public is safe only while no client role
-- can create objects in public -- true by default on Supabase and on PostgreSQL 15+, but an
-- assumption about someone else's defaults rather than something this file controls. An empty
-- path removes the assumption: every object this body touches is either written out in full
-- (public.sync_event_log) or lives in pg_catalog, which PostgreSQL always searches first and
-- which cannot be shadowed. COALESCE and || are SQL constructs and are not qualifiable at all.
create or replace function public.log_qr_master_insert() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Serialise log writers. Taken BEFORE the insert, because the insert is what calls nextval():
  -- after it, the position is already out and the race has already happened. See the note at the
  -- top of this file for why a snapshot watermark does not do this job.
  perform pg_advisory_xact_lock(777, 1);

  insert into public.sync_event_log (dedupe_key, aggregate_type, aggregate_id, payload)
  values (
    'QR_MASTER:' || new.qr_id,
    'QR_MASTER',
    new.qr_id,
    jsonb_build_object(
      'qrId', new.qr_id,
      'productVariantId', new.product_variant_id,
      'createdAt', new.created_at
    )
  )
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_qr_master_log on qr_master;
create trigger trg_qr_master_log
after insert on qr_master
for each row execute procedure public.log_qr_master_insert();

-- ── PRODUCTION_PRODUCED: one production scan, with every column its row needs ──

-- Empty search path, for the reason given on log_qr_master_insert above.
create or replace function public.log_production_produced_insert() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Only the production scan has a contract. The other event types still share the old
  -- catch-all name locally and are not logged until each has one of its own.
  if new.event_type <> 'PRODUCED' then
    return new;
  end if;

  -- The same lock, and the same key, as log_qr_master_insert. It is taken only once the event is
  -- known to be loggable, so a write that logs nothing does not serialise against anything. A
  -- transaction that records a carton and its scan takes it twice, which is fine: advisory locks
  -- are re-entrant within a transaction.
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

drop trigger if exists trg_production_events_log on production_events;
create trigger trg_production_events_log
after insert on production_events
for each row execute procedure public.log_production_produced_insert();

-- Nothing may rewrite history. The log is append-only for every role including the owner's
-- application code -- a correction is a new event, never an edit to an old one.
create or replace function public.refuse_sync_log_change() returns trigger
language plpgsql
as $$
begin
  raise exception 'sync_event_log is append-only';
end;
$$;

drop trigger if exists trg_sync_event_log_immutable on sync_event_log;
create trigger trg_sync_event_log_immutable
before update or delete on sync_event_log
for each row execute procedure public.refuse_sync_log_change();

-- ── Nothing may call these directly ──
--
-- PostgreSQL grants EXECUTE on a new function to PUBLIC, and Supabase grants it to anon and
-- authenticated as well by default, so without this all three would be callable by any client.
-- A direct grant is not removed by revoking from PUBLIC, so the named roles are revoked too.
--
-- In practice this closes a surface rather than a hole: a function declared `returns trigger`
-- cannot be invoked as an ordinary function -- the call is refused before the body runs, so no
-- advisory lock is taken and nothing is written. It is still worth taking away.
--
-- THESE REVOKES DO NOT STOP THE TRIGGERS. PostgreSQL checks EXECUTE on a trigger function when
-- the trigger is CREATED, not each time it fires: the function is invoked by the trigger
-- machinery, not called by the inserting role. That is why they come after the triggers exist.
-- It is also the one claim in this file that reading cannot settle -- see the foot of the file.

revoke all on function public.log_qr_master_insert() from public, anon, authenticated;
revoke all on function public.log_production_produced_insert() from public, anon, authenticated;
revoke all on function public.refuse_sync_log_change() from public, anon, authenticated;

-- ── And nothing may burn log positions ──
--
-- A client cannot write a log row: Row Level Security refuses it, and migration 004 revokes the
-- insert privilege as well. But a bigserial has a sequence of its own, and Supabase grants ALL
-- ON SEQUENCES in public to anon and authenticated by default -- so a client could call
-- nextval() and advance it at will, leaving holes.
--
-- Holes are harmless by design here, which bounds that to a nuisance rather than data loss, and
-- it costs one statement to close. The owner keeps its privileges: revoking from these roles
-- does not touch the sequence's owner, and the logging functions are SECURITY DEFINER, so
-- nextval() runs as the owner when a trigger fires.
revoke all on sequence public.sync_event_log_seq_seq from public, anon, authenticated;

commit;

-- WHAT STILL HAS TO BE PROVED BY RUNNING THIS, not by reading it:
--
--   1. That the revokes above do not stop the triggers firing. Insert one qr_master row after
--      applying migration 004 and check that a sync_event_log row appears. If the log stays
--      empty, these three revokes are the cause and removing them restores it.
--   2. That pg_advisory_xact_lock really serialises two concurrent sessions, and is really
--      released on rollback. Two psql sessions, one holding a transaction open, is enough.
--   3. That an empty search_path leaves pg_catalog reachable, so pg_advisory_xact_lock and
--      jsonb_build_object still resolve inside the function bodies. The first insert settles it.
