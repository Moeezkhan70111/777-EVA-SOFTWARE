-- Puts the cloud back to where migrations 004 and 005 left it.
--
-- ⚠ REVERSING THIS RE-OPENS UNBOUND ACCESS. After this file runs, any account with a
-- device_accounts row can write again with no claim, no device binding and no workstation
-- check: the enrolment is once more two strings that can be copied to a second computer, and
-- nothing will notice that they were.
--
-- ⚠ IT ALSO RE-ENABLES REVOKED DEVICES. Revocation here is `revoked_at` on a row that only
-- these functions read. With the functions gone, a device revoked before the rollback can push
-- again the moment the insert grant is restored. Revocation is only durable if the Supabase
-- Auth user is ALSO disabled, which is an owner action in the dashboard and not something any
-- migration can do. Disable the account first if the revocation must survive this.
--
-- ⚠ AND IT DISCARDS THE AUDIT. device_claim_events holds the record of which identities were
-- claimed from more than one place. Export it before running this if any of it matters.
--
-- The order is the reverse of the up file: the privilege comes back and the policy is restored
-- before the functions those decisions replaced are dropped, and the columns go last so
-- nothing still reads them.
--
-- The device credentials on each computer are untouched by this -- they are encrypted blobs in
-- each machine's own data folder, and a rollback simply stops anything checking them.

begin;

-- ── The direct write path comes back ──

grant insert on qr_master, production_events to authenticated;

-- ── And so does the table-level read of device_accounts ──
--
-- ⚠ The claim columns are about to be dropped, so there is nothing secret left to protect --
-- but a rollback that left per-column grants behind would be a half-restored permission model
-- nobody could reason about later. The column grants go first (they name columns this file
-- drops further down), then 004's table-level grant is restored exactly as it was.
--
-- Dropping a column takes its column-level grants with it, so the two statements below are
-- about the columns that SURVIVE the rollback.

revoke select (
  auth_user_id,
  factory_id,
  workstation_id,
  device_id,
  label,
  is_active,
  enrolled_at,
  revoked_at,
  replaced_by,
  last_seen_at,
  last_seen_version
) on device_accounts from authenticated;

grant select on device_accounts to authenticated;

-- ── The insert policy as 004 wrote it, without the workstation clause ──

drop policy if exists device_inserts_production_events on production_events;
create policy device_inserts_production_events on production_events
for insert to authenticated
with check (
  is_enrolled_device()
  and factory_id = current_factory_id()
  and event_type = 'PRODUCED'
  and exists (select 1 from qr_master qm where qm.qr_id = production_events.qr_id)
);

-- ── The functions ──

drop function if exists public.push_production_produced(bigint, uuid, jsonb);
drop function if exists public.push_qr_master(bigint, uuid, jsonb);
drop function if exists public.heartbeat_device(bigint, uuid);
drop function if exists public.claim_is_current(bigint, uuid);
drop function if exists public.claim_device(text, text, text);
drop function if exists public.current_workstation_id();

-- ── The audit ──

drop trigger if exists trg_device_claim_events_immutable on device_claim_events;
drop function if exists public.refuse_claim_log_change();
drop table if exists device_claim_events;

-- ── The binding ──
--
-- Dropped last, and dropping them discards which computer each account belonged to. Re-applying
-- 006 afterwards leaves every enrolment with a null device id -- that is, unusable until the
-- owner records the bindings again, which is the fail-closed behaviour and not a fault.

-- Reverse order: the constraint stops referencing the pair before either side of it goes. The
-- foreign key first, then its target index, then the account's own index, then the columns.
-- Dropping device_id would take the constraint with it anyway, but doing it in this order means
-- no statement here depends on that side effect.
--
-- idx_workstations_id_device is dropped because this file created it and nothing else uses it.
-- No row of workstations was ever touched, so there is nothing in that table to restore.

alter table device_accounts drop constraint if exists device_accounts_workstation_device_fkey;
drop index if exists idx_workstations_id_device;
drop index if exists idx_device_accounts_device_id;
alter table device_accounts drop column if exists replaced_by;
alter table device_accounts drop column if exists last_seen_version;
alter table device_accounts drop column if exists last_seen_at;
alter table device_accounts drop column if exists claim_holder;
alter table device_accounts drop column if exists claim_epoch;
alter table device_accounts drop column if exists device_id;

commit;
