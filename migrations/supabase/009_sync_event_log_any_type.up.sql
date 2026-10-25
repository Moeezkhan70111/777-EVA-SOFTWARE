-- The event log stops being hard-wired to two event types.
--
-- WHAT IS WRONG TODAY. sync_event_log accepts exactly QR_MASTER and PRODUCTION_PRODUCED, and says
-- so three times over: a CHECK on aggregate_type (003), a CHECK pairing each of the two with its
-- factory rule (005), and a read policy naming QR_MASTER as the one global type (005). Raw material
-- is the next domain to replicate (docs/37, owner decision 2026-10-23), and every new event type
-- would otherwise mean rewriting two constraints and a policy -- by hand, because they are drop and
-- revoke work the MCP tools refuse.
--
-- WHAT THIS DOES. The types the log accepts become ROWS, in sync_aggregate_types, each saying
-- whether its events are factory-scoped. A trigger enforces the scope rule from that table, and the
-- read policy reads "your factory, or none". After this a new type is one INSERT here plus its log
-- trigger, and the constraints and the policy are never touched again.
--
-- THE SCOPE RULE IS 005's, GENERALISED, NOT CHANGED. An event that names a factory is scoped to it:
-- a production scan (and, later, a raw-material movement). An identity that names no factory is
-- global, by the owner's decision of 2026-10-17 for cartons: a carton, a product variant, and now a
-- raw-material label run and packet, none of which has a tenant column. The trigger makes a scoped
-- type without a factory, or a global type with one, impossible -- exactly what 005's CHECK did for
-- its two types.
--
-- SEEDED with the two types already logged, PRODUCT_VARIANT (already pushed by 008, and NOT YET
-- LOGGED -- see the note at the foot), and the two raw-material identity types. Allowing a type
-- here writes nothing by itself: a type only reaches the log through a trigger on its own table.
--
-- ORDER AND CURSORS ARE UNCHANGED. Positions are still taken under the same advisory lock by the
-- same per-table triggers. The new trigger runs BEFORE the insert and only refuses -- it takes no
-- position and writes nothing.
--
-- Paste whole, in the SQL editor of the TEST project first (docs/36 section 6a). Requires the table
-- owner for ALTER TABLE.

begin;

-- ── The types the log accepts ──

create table if not exists public.sync_aggregate_types (
  aggregate_type text primary key,
  -- True: every event of this type names its factory, and a device reads only its own factory's.
  -- False: the type names no factory, and every enrolled device reads it.
  factory_scoped boolean not null,
  -- Why it is scoped or global, so the next person does not have to rediscover it.
  note text not null
);

-- RLS on from the moment it exists, and nothing granted: no client reads or writes this table. The
-- scope trigger below is SECURITY DEFINER and reads it as the owner.
alter table public.sync_aggregate_types enable row level security;
revoke all on table public.sync_aggregate_types from public, anon, authenticated;

insert into public.sync_aggregate_types (aggregate_type, factory_scoped, note) values
  ('QR_MASTER', false, 'A carton identity. Names no factory: global by the owner decision of 2026-10-17 (005).'),
  ('PRODUCTION_PRODUCED', true, 'A production scan. Names its factory, which 004 requires to be the pushing device''s.'),
  ('PRODUCT_VARIANT', false, 'A product variant (008). Names no factory, like the carton it belongs to.'),
  ('RAW_MATERIAL_QR_BATCH', false, 'A raw-material label run. Names a supplier and a material, no factory: global like a carton.'),
  ('RAW_MATERIAL_QR', false, 'A raw-material packet identity. Names no factory: global like a carton.')
on conflict (aggregate_type) do nothing;

-- ── The log refers to it instead of listing types ──

alter table public.sync_event_log drop constraint if exists sync_event_log_aggregate_type_check;
alter table public.sync_event_log drop constraint if exists sync_event_log_aggregate_type_fkey;
alter table public.sync_event_log
  add constraint sync_event_log_aggregate_type_fkey
  foreign key (aggregate_type) references public.sync_aggregate_types (aggregate_type);

-- 005's pairing of each type with its factory rule gives way to the trigger below. Dropped only in
-- the same transaction that installs its replacement, so the rule is never absent.
alter table public.sync_event_log drop constraint if exists sync_event_log_factory_scope;

-- Empty search path, for the reason given in 003: every object is written out in full.
create or replace function public.enforce_sync_event_log_scope() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  scoped boolean;
begin
  select factory_scoped into scoped
    from public.sync_aggregate_types
   where aggregate_type = new.aggregate_type;
  -- An unknown type is also refused by the foreign key. Refused here first, with a clearer message.
  if scoped is null then
    raise exception 'sync_event_log: % is not a type the log accepts', new.aggregate_type;
  end if;
  if scoped and new.factory_id is null then
    raise exception 'sync_event_log: % events must name their factory', new.aggregate_type;
  end if;
  if not scoped and new.factory_id is not null then
    raise exception 'sync_event_log: % names no factory and must not be given one', new.aggregate_type;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_event_log_scope on public.sync_event_log;
create trigger trg_sync_event_log_scope
before insert on public.sync_event_log
for each row execute procedure public.enforce_sync_event_log_scope();

-- Like every trigger function here: nothing may call it directly. EXECUTE is checked when the
-- trigger is created, not when it fires, so this does not stop the trigger (see 003's foot).
revoke all on function public.enforce_sync_event_log_scope() from public, anon, authenticated;

-- ── The read policy: your factory, or none ──
--
-- The trigger guarantees a null factory only ever belongs to a global type, so "factory_id is null"
-- now says exactly what "factory_id is null and aggregate_type = 'QR_MASTER'" said, for every type.

drop policy if exists device_reads_sync_event_log on public.sync_event_log;
create policy device_reads_sync_event_log on public.sync_event_log
for select to authenticated
using (
  public.is_enrolled_device()
  and (factory_id = public.current_factory_id() or factory_id is null)
);

commit;

-- WHAT STILL HAS TO BE PROVED BY RUNNING THIS, on test first:
--
--   1. migrations/supabase/verify_applied_state.sql -- updated for this migration -- is all ok.
--   2. A production scan still logs (the 003-after-005 detector, and one real scan).
--   3. An insert of a global type with a factory, and of a scoped type without one, is refused.
--
-- NOTE, found while writing this (2026-10-25): 008's push_product_variant stores a variant but no
-- trigger LOGS it, so no other computer can ever pull one. PRODUCT_VARIANT is allowed here so that
-- fixing it is one trigger on product_variants, plus a backfill of the variants already stored.
