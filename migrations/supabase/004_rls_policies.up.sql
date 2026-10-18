-- WHO MAY READ AND WRITE WHAT.
--
-- supabase/schema.sql turns Row Level Security on for every table and defines no policy at all --
-- only two commented-out examples. With RLS on and no policy, Postgres denies everything to anon
-- and authenticated, so a computer would connect successfully and see nothing, and push nothing.
-- Only the service_role key would work, and that key must never be in the desktop application.
-- This migration is the missing half. RLS is never turned off to make something work.
--
-- THE AUTHENTICATION MODEL
--
--   One Supabase Auth account per computer -- a device account, created by the owner when the
--   computer is enrolled. The desktop application signs in with it and holds a short-lived access
--   token. It never holds a service_role key, and the anon key it ships with grants nothing on its
--   own because anon has no policy here.
--
--   An account is only a device once the owner has said so, by adding a row to device_accounts
--   below. A brand-new Supabase user that nobody enrolled can authenticate and still read and
--   write nothing. Enrolment is a deliberate act with privileged access, not something the
--   application can do for itself.
--
-- WHAT A DEVICE MAY DO
--
--   read    the master data it needs, the cartons, the production events, and the ordered log
--   insert  cartons and production events -- the two contracts that exist today
--   never   update or delete anything, and never write master data
--
-- WHY NO UPDATE AND NO DELETE. production_events and sync_event_log are history. A client that
-- can edit history can quietly change what the factory produced. Corrections are new events.
-- qr_master is insert-only for the same reason today: its status column moves as a carton travels,
-- and that movement has no event contract yet, so nothing is allowed to set it remotely.
--
-- WHY MASTER DATA IS READ-ONLY. A computer must not be able to invent a product, a factory or a
-- workstation. Those rows are provisioned by the owner, and a device that meets a carton naming a
-- product it does not have refuses it visibly instead of creating one.
--
-- SINGLE FACTORY TODAY. Scoping is applied where a factory_id column exists. qr_master and
-- product_variants have no factory column, so they are scoped to "the caller is an enrolled
-- device" only. A second factory would need a tenant column on those tables first -- a schema
-- change, not a policy change, and it is not pretended here.

begin;

-- ── Which auth accounts are computers, and whose ──

create table if not exists device_accounts (
  -- The Supabase Auth user. No foreign key to auth.users on purpose: this table is readable by
  -- devices, and auth.users is not theirs to join.
  auth_user_id uuid primary key,
  factory_id text not null references factories(id),
  -- The workstation this computer records its scans as. Informational for the policies below.
  workstation_id text references workstations(id),
  label text not null,
  is_active boolean not null default true,
  enrolled_at timestamptz not null default now(),
  revoked_at timestamptz
);

alter table device_accounts enable row level security;

-- ── The two questions every policy asks ──
--
-- Both pin an EMPTY search path and write out public.device_accounts, for the same reason as
-- the logging functions in migration 003: a path pinned to public is only safe while no client
-- role can create objects there, which is someone else than this file deciding. auth.uid() is
-- already schema-qualified, and pg_catalog stays reachable with an empty path.

/* Is the caller an enrolled, un-revoked device? */
create or replace function public.is_enrolled_device() returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.device_accounts
     where auth_user_id = auth.uid()
       and is_active
       and revoked_at is null
  );
$$;

/* Which factory is the caller's? Null when the caller is not an enrolled device. */
create or replace function public.current_factory_id() returns text
language sql
stable
security definer
set search_path = ''
as $$
  select factory_id from public.device_accounts
   where auth_user_id = auth.uid()
     and is_active
     and revoked_at is null
   limit 1;
$$;

-- ── anon gets nothing, explicitly ──
--
-- The anon key ships in the desktop application, so it must be worth nothing by itself. RLS with
-- no anon policy already denies everything; revoking the table privileges Supabase grants by
-- default is the second lock on the same door.

revoke all on factories from anon;
revoke all on workstations from anon;
revoke all on operators from anon;
revoke all on product_variants from anon;
revoke all on qr_master from anon;
revoke all on production_events from anon;
revoke all on sync_event_log from anon;
revoke all on device_accounts from anon;

-- ── A device may see which device it is, and nothing about any other ──

drop policy if exists device_reads_own_enrolment on device_accounts;
create policy device_reads_own_enrolment on device_accounts
for select to authenticated
using (auth_user_id = auth.uid());

-- ── Master data: read only, and only for an enrolled device ──

drop policy if exists device_reads_factories on factories;
create policy device_reads_factories on factories
for select to authenticated
using (id = current_factory_id());

drop policy if exists device_reads_workstations on workstations;
create policy device_reads_workstations on workstations
for select to authenticated
using (factory_id = current_factory_id());

drop policy if exists device_reads_operators on operators;
create policy device_reads_operators on operators
for select to authenticated
using (is_enrolled_device());

drop policy if exists device_reads_product_variants on product_variants;
create policy device_reads_product_variants on product_variants
for select to authenticated
using (is_enrolled_device());

-- ── Cartons: read, and insert the identity ──

drop policy if exists device_reads_qr_master on qr_master;
create policy device_reads_qr_master on qr_master
for select to authenticated
using (is_enrolled_device());

drop policy if exists device_inserts_qr_master on qr_master;
create policy device_inserts_qr_master on qr_master
for insert to authenticated
with check (
  is_enrolled_device()
  -- A carton may only be registered against a product the factory already has.
  --
  -- The new row's column is qualified with the table name on purpose. Unqualified, a name that
  -- also exists inside the subquery would resolve to the SUBQUERY's column, and the test would
  -- collapse into "does any row exist at all" -- true for every insert.
  and exists (select 1 from product_variants pv where pv.id = qr_master.product_variant_id)
  -- Registered as produced at the factory, which is the only state the contract carries. Any
  -- other opening state would be a movement, and movement has no contract yet.
  and current_status = 'PRODUCED'
  and current_location_type = 'FACTORY'
);

-- ── Production events: read, and insert a PRODUCED scan ──

drop policy if exists device_reads_production_events on production_events;
create policy device_reads_production_events on production_events
for select to authenticated
using (factory_id = current_factory_id());

drop policy if exists device_inserts_production_events on production_events;
create policy device_inserts_production_events on production_events
for insert to authenticated
with check (
  is_enrolled_device()
  -- A device may only write events for its own factory.
  and factory_id = current_factory_id()
  -- Only the one event type that has a contract. DAMAGED, MOVED, DISPATCHED, RETURNED and
  -- ADJUSTMENT are refused here until each is designed and tested.
  and event_type = 'PRODUCED'
  -- The carton must already be registered. The identity is pushed first for exactly this reason.
  -- Qualified for the reason given on the qr_master policy above: unqualified, `qr_id` would
  -- resolve to the subquery's own column and the check would pass for any carton at all.
  and exists (select 1 from qr_master qm where qm.qr_id = production_events.qr_id)
);

-- ── The ordered log: read only, for everyone ──
--
-- No insert policy, by design: the log is filled by the triggers in migration 003, which run as
-- the function owner. A device cannot add to it, and the append-only trigger stops anything from
-- changing it.

drop policy if exists device_reads_sync_event_log on sync_event_log;
create policy device_reads_sync_event_log on sync_event_log
for select to authenticated
using (is_enrolled_device());

-- ── What authenticated is granted at all ──
--
-- Policies decide which rows. These decide which verbs are even on the table, so an update or a
-- delete is refused before a policy is consulted.

grant select on factories, workstations, operators, product_variants, sync_event_log, device_accounts to authenticated;
grant select, insert on qr_master, production_events to authenticated;
revoke update, delete on qr_master, production_events from authenticated;
revoke insert, update, delete on sync_event_log from authenticated;
-- Enrolment is the owner's act. Row Level Security already refuses a write here, because there is
-- no insert, update or delete policy -- this takes the privilege away as well, so a permissive
-- policy added later cannot quietly open it.
revoke insert, update, delete on device_accounts from authenticated;
revoke insert, update, delete on factories, workstations, operators, product_variants from authenticated;

-- ── Who may call the helpers ──
--
-- Postgres grants EXECUTE on a new function to PUBLIC, and Supabase grants it to anon and
-- authenticated as well, so a direct grant has to be taken away by name as well as from PUBLIC.
-- These two read device_accounts as their definer, so they are taken from everyone and given
-- back only to a signed-in caller. Each still only ever answers about the caller's own account.
--
-- authenticated MUST keep EXECUTE here, unlike the trigger functions: a policy expression is
-- evaluated with the querying role's privileges, so a device that could not call
-- is_enrolled_device() would have every policy below fail rather than simply deny.
revoke all on function public.is_enrolled_device() from public, anon, authenticated;
revoke all on function public.current_factory_id() from public, anon, authenticated;
grant execute on function public.is_enrolled_device() to authenticated;
grant execute on function public.current_factory_id() to authenticated;

-- The three trigger functions from migration 003 are revoked there, beside the triggers they
-- belong to, so that privilege lives in one place rather than two.

commit;
