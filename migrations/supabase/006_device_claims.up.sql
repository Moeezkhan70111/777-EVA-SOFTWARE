-- A cloud account stops being enough. A device has to claim its identity, and keep it.
--
-- WHAT IS WRONG TODAY. Migration 004 authorises a write on one question: is the caller an
-- enrolled device? The answer comes from auth.uid(), which is the Supabase account named by
-- ERP_DEVICE_EMAIL and ERP_DEVICE_PASSWORD. Those are two strings. Copy them, or copy the data
-- folder they were typed into, and a second computer is indistinguishable from the first: it
-- writes cartons and production under the same enrolment, and nothing anywhere notices.
--
-- `device_accounts.workstation_id` says in 004 that it is "informational for the policies
-- below", and it is: no policy reads it. So a device may also write events attributed to any
-- workstation in its factory, not only its own.
--
-- WHAT THIS DOES.
--
--   1. BINDS the account to one device id and one workstation. Both become the account's, and
--      a device id belongs to at most one account.
--   2. CLAIMS. claim_device() bumps a monotonic epoch under a row lock and hands back that
--      epoch and a fresh holder token. Two computers presenting one enrolment therefore evict
--      each other: each claim supersedes the last, and the loser's next write is refused. No
--      lease, no timeout, no clock to agree on, and a crash costs nothing -- the next claim
--      simply wins.
--   3. VALIDATES EVERY WRITE against the current claim, in the same transaction as the write.
--      A claim RPC on its own would be theatre: it is the writes that must refuse a stale one.
--   4. TAKES THE WRITE PRIVILEGE AWAY. authenticated keeps select and loses insert on qr_master
--      and production_events. After this, the two RPCs are the only way in -- so a write that
--      forgets to check the claim cannot be written, because there is nowhere to write it.
--
-- WHY THE RPCs RE-CHECK WHAT 004 ALREADY CHECKS. No table here is FORCE ROW LEVEL SECURITY, so
-- a SECURITY DEFINER function owned by the table owner bypasses RLS entirely. The policies in
-- 004 do not apply inside these functions; every rule they state is therefore restated here,
-- and the policies stay as a second lock for as long as any direct path remains.
--
-- QR_MASTER STAYS GLOBAL. The owner decided on 2026-10-17 that carton identities are not scoped
-- per factory (see 005 and the README): qr_master has no tenant column, and inventing one here
-- would be a schema change nobody asked for. push_qr_master checks the claim and the product,
-- and deliberately checks no factory.
--
-- FAIL CLOSED, EVERY TIME. No enrolment, a revoked one, no device id recorded, no workstation
-- recorded, the wrong device id, the wrong workstation, the wrong factory, an unknown epoch, a
-- superseded holder: each is a refusal, and a refusal writes nothing.
--
-- NOT APPLIED. Like 005, this file is reviewed SQL waiting for a decision.
--
-- APPLYING THIS BREAKS THE CURRENT PUSH UNTIL THE CLIENT IS CHANGED. packages/sync's transport
-- pushes by POSTing to /rest/v1/qr_master, which this file revokes. The transport must move to
-- /rest/v1/rpc/push_qr_master in the same change window. Nothing has ever been pushed, so there
-- is nothing in flight to strand -- but do not apply this to a project a client is using.

begin;

-- ── The binding ──
--
-- Nullable on purpose. Existing enrolments have no device id, and inventing one for them would
-- be guessing which computer they are. They stay unusable until the owner records it, which is
-- the fail-closed behaviour: every function below refuses a null binding.

alter table device_accounts add column if not exists device_id text;
alter table device_accounts add column if not exists claim_epoch bigint not null default 0;
alter table device_accounts add column if not exists claim_holder uuid;
alter table device_accounts add column if not exists last_seen_at timestamptz;
alter table device_accounts add column if not exists last_seen_version text;
-- Points at the account that replaced this one, so a workstation swap keeps its history.
alter table device_accounts add column if not exists replaced_by uuid;

-- One device id to at most one account. auth_user_id is already the primary key, so the other
-- direction -- one account to at most one device id -- is a column, not a constraint.
-- Nulls do not conflict in a unique index, so unrecorded bindings coexist until they are set.
create unique index if not exists idx_device_accounts_device_id on device_accounts(device_id);

-- ── And the device id has to be the one that workstation actually belongs to ──
--
-- TWO RECORDS OF ONE FACT. workstations.device_id already says which computer a station belongs
-- to -- `text not null unique` since the baseline schema, untouched by 002 -- and the local
-- application treats it as the authority: ensureOperationalContext writes it from the
-- installation's own deviceId, and resolveInstallation reads the deviceId BACK out of it when it
-- adopts a database's existing workstation. Without the constraint below, device_accounts could
-- name a different one and nothing would notice: claim_device compares the client's arguments
-- against the account's own columns and never looks at the workstations row, so every claim and
-- every push would succeed while the cloud held two different answers to "which computer is
-- this?". push_production_produced now pins each event's device_id to the account's, so the
-- disagreement would be written into history rather than caught.
--
-- An FK to devices(id) would read more naturally and is not possible: 002 converts
-- devices.factory_id and devices.workstation_id to text and leaves devices.id as uuid, and a
-- text column cannot reference a uuid key. workstations.device_id is the only viable anchor.
--
-- THE INDEX IS THE FK's TARGET AND NOTHING ELSE. (id, device_id) is already unique because id is
-- the primary key; PostgreSQL still requires a unique index on exactly the referenced columns.
-- Building it reads workstations and rewrites nothing -- no row in that table is touched by this
-- migration, deliberately, because which computer a station belongs to is the owner's record and
-- not this file's to correct.
--
-- MATCH SIMPLE, which is the default and must stay so. A composite foreign key under MATCH
-- SIMPLE is satisfied whenever ANY referencing column is null, so every enrolment carrying the
-- null device_id this file leaves behind passes untouched, and only a RECORDED binding is
-- checked. `match full` would demand both columns and reject exactly those rows, rolling the
-- whole migration back.
--
-- NO CASCADE, also the default. If the owner ever changes a workstation's device_id while an
-- account still points at the old pair, this refuses and makes them re-enrol deliberately --
-- that is what replaced_by is for. `on update cascade` would silently re-point an enrolment at a
-- different physical computer, which is the one outcome device binding exists to prevent.

create unique index if not exists idx_workstations_id_device on workstations(id, device_id);

alter table device_accounts drop constraint if exists device_accounts_workstation_device_fkey;
alter table device_accounts add constraint device_accounts_workstation_device_fkey
  foreign key (workstation_id, device_id) references workstations (id, device_id);

-- ── The claim state is not the client's to read ──
--
-- THE HOLDER IS A SECRET THE SERVER ISSUES AND THE CLIENT KEEPS. Eviction works only because a
-- superseded device cannot learn the epoch and holder that replaced its own: claim_device is
-- the single place either value is ever disclosed, and it discloses them only to the caller it
-- just issued them to.
--
-- Without this block the whole mechanism is decorative. Migration 004 grants a table-level
-- select on device_accounts and lets a device read its own row, and two copies of one enrolment
-- share one auth.uid() -- so the evicted copy could simply SELECT the current claim_epoch and
-- claim_holder out of the table and carry on writing, never calling claim_device and never
-- being evicted at all.
--
-- A COLUMN-LEVEL REVOKE ALONE WOULD DO NOTHING. In PostgreSQL a table-level privilege dominates
-- the column-level ones: while `authenticated` holds select on the table it may read every
-- column, and `revoke select (claim_holder)` changes nothing. The table-level grant therefore
-- has to go, and the columns a device legitimately needs are granted back by name.
--
-- A useful consequence: a column added to this table later is private until someone grants it
-- deliberately, which is the right default for anything else the claim machinery grows.
--
-- The row filter is unchanged -- device_reads_own_enrolment still limits a device to its own
-- row -- and the three helper functions are SECURITY DEFINER, so they read what they always did.

revoke select on device_accounts from authenticated;
grant select (
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
) on device_accounts to authenticated;

-- ── The audit ──
--
-- Every claim, supersession, refusal, revocation and re-enrolment, append-only. It holds ids
-- and reasons: never a token, a password, an epoch holder of any other device, or a key.

create table if not exists device_claim_events (
  seq bigserial primary key,
  auth_user_id uuid not null,
  device_id text,
  workstation_id text,
  event text not null check (event in ('CLAIMED','SUPERSEDED','REFUSED','REVOKED','REENROLLED')),
  claim_epoch bigint,
  -- A short machine-readable reason, e.g. DEVICE_MISMATCH. Never free text from a client.
  detail text,
  app_version text,
  logged_at timestamptz not null default now()
);

create index if not exists idx_device_claim_events_account on device_claim_events(auth_user_id, seq);

alter table device_claim_events enable row level security;

-- No policy, deliberately: this is the owner's record of who claimed what, and a device has no
-- business reading another device's refusals. RLS with no policy denies everything; the revoke
-- below is the second lock on the same door.
revoke all on device_claim_events from anon, authenticated;
revoke all on sequence device_claim_events_seq_seq from anon, authenticated;

create or replace function public.refuse_claim_log_change() returns trigger
language plpgsql
as $$
begin
  raise exception 'device_claim_events is append-only';
end;
$$;

drop trigger if exists trg_device_claim_events_immutable on device_claim_events;
create trigger trg_device_claim_events_immutable
before update or delete on device_claim_events
for each row execute procedure public.refuse_claim_log_change();

-- ── Which workstation is the caller's ──
--
-- The third question the policies ask, beside is_enrolled_device() and current_factory_id(),
-- and written exactly as those two are: empty search path, everything qualified.

create or replace function public.current_workstation_id() returns text
language sql
stable
security definer
set search_path = ''
as $$
  select workstation_id from public.device_accounts
   where auth_user_id = auth.uid()
     and is_active
     and revoked_at is null
   limit 1;
$$;

-- ── Claiming ──
--
-- The row lock is what makes the epoch monotonic: two claims cannot both read 5 and both write
-- 6. The loser waits, reads 6, and writes 7.
--
-- Returns jsonb rather than a row type so a refusal carries a reason the client can classify.
-- A refused claim must never be mistaken for a refused EVENT: the client treats it as a reason
-- to stop the pass, not as a verdict on anything queued, or revoking a device would park its
-- outbox for good.

create or replace function public.claim_device(
  p_device_id text,
  p_workstation_id text,
  p_app_version text default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  account public.device_accounts%rowtype;
  new_epoch bigint;
  new_holder uuid;
begin
  -- NO CALLER, NO REFUSAL TO RECORD. auth.uid() reads request.jwt.claim.sub, and there are two
  -- ways to arrive here without one: the Supabase SQL editor, which runs as the table owner over
  -- a direct connection with no PostgREST request at all, and a JWT for role `authenticated`
  -- carrying no `sub`. Neither is a client -- `anon` has no execute grant on this function -- but
  -- both used to produce the WRONG failure. The lookup below would find no row, the NOT_ENROLLED
  -- branch would then try to log the refusal, and device_claim_events.auth_user_id is `not null`
  -- on purpose, so that insert raised and the reasoned refusal never came back.
  --
  -- Refused here instead, before the lookup and before anything is written. NOT_ENROLLED is the
  -- honest answer -- no enrolled account is making this call -- and it is a reason the client
  -- already classifies, so nothing downstream changes. No audit row is written because there is
  -- no account to attribute one to: an unattributable line in the owner's record of who claimed
  -- what would be worse than its absence, which is also why auth_user_id stays `not null`.
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'NOT_ENROLLED');
  end if;

  select * into account from public.device_accounts
   where auth_user_id = auth.uid()
   for update;

  if not found then
    insert into public.device_claim_events (auth_user_id, device_id, event, detail, app_version)
    values (auth.uid(), p_device_id, 'REFUSED', 'NOT_ENROLLED', p_app_version);
    return jsonb_build_object('ok', false, 'reason', 'NOT_ENROLLED');
  end if;

  if not account.is_active or account.revoked_at is not null then
    insert into public.device_claim_events (auth_user_id, device_id, event, detail, app_version)
    values (auth.uid(), p_device_id, 'REFUSED', 'REVOKED', p_app_version);
    return jsonb_build_object('ok', false, 'reason', 'REVOKED');
  end if;

  -- An enrolment with nothing recorded cannot be matched against anything, so it is refused
  -- rather than treated as matching everything.
  if account.device_id is null or account.workstation_id is null then
    insert into public.device_claim_events (auth_user_id, device_id, event, detail, app_version)
    values (auth.uid(), p_device_id, 'REFUSED', 'BINDING_INCOMPLETE', p_app_version);
    return jsonb_build_object('ok', false, 'reason', 'BINDING_INCOMPLETE');
  end if;

  if p_device_id is distinct from account.device_id then
    insert into public.device_claim_events (auth_user_id, device_id, event, detail, app_version)
    values (auth.uid(), p_device_id, 'REFUSED', 'DEVICE_MISMATCH', p_app_version);
    return jsonb_build_object('ok', false, 'reason', 'DEVICE_MISMATCH');
  end if;

  if p_workstation_id is distinct from account.workstation_id then
    insert into public.device_claim_events (auth_user_id, device_id, workstation_id, event, detail, app_version)
    values (auth.uid(), p_device_id, p_workstation_id, 'REFUSED', 'WORKSTATION_MISMATCH', p_app_version);
    return jsonb_build_object('ok', false, 'reason', 'WORKSTATION_MISMATCH');
  end if;

  new_epoch := account.claim_epoch + 1;
  new_holder := gen_random_uuid();

  update public.device_accounts
     set claim_epoch = new_epoch,
         claim_holder = new_holder,
         last_seen_at = now(),
         last_seen_version = p_app_version
   where auth_user_id = auth.uid();

  -- The previous holder has just been evicted. Recorded as its own line so a copied identity
  -- shows up as a run of supersessions rather than as nothing at all.
  if account.claim_holder is not null then
    insert into public.device_claim_events (auth_user_id, device_id, workstation_id, event, claim_epoch, detail, app_version)
    values (auth.uid(), account.device_id, account.workstation_id, 'SUPERSEDED', account.claim_epoch, 'CLAIMED_AGAIN', p_app_version);
  end if;

  insert into public.device_claim_events (auth_user_id, device_id, workstation_id, event, claim_epoch, app_version)
  values (auth.uid(), account.device_id, account.workstation_id, 'CLAIMED', new_epoch, p_app_version);

  return jsonb_build_object('ok', true, 'epoch', new_epoch, 'holder', new_holder);
end;
$$;

-- ── The check every write makes ──
--
-- Internal. Not granted to any client role: it is called only by the functions below, which run
-- as the owner. `for share` is deliberate -- it blocks a concurrent claim_device() (which takes
-- `for update`) until this transaction commits, so an epoch that validates here is still the
-- current one when the row lands. That is what makes validation atomic with the write rather
-- than merely close to it.

create or replace function public.claim_is_current(p_epoch bigint, p_holder uuid)
returns public.device_accounts
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  account public.device_accounts%rowtype;
begin
  select * into account from public.device_accounts
   where auth_user_id = auth.uid()
   for share;

  if not found then
    raise exception 'NOT_ENROLLED' using errcode = '42501';
  end if;
  if not account.is_active or account.revoked_at is not null then
    raise exception 'REVOKED' using errcode = '42501';
  end if;
  if account.device_id is null or account.workstation_id is null then
    raise exception 'BINDING_INCOMPLETE' using errcode = '42501';
  end if;
  if account.claim_epoch = 0 or account.claim_holder is null then
    raise exception 'NOT_CLAIMED' using errcode = '42501';
  end if;
  if p_epoch is distinct from account.claim_epoch or p_holder is distinct from account.claim_holder then
    raise exception 'CLAIM_SUPERSEDED' using errcode = '42501';
  end if;

  return account;
end;
$$;

-- ── Heartbeat ──

create or replace function public.heartbeat_device(p_epoch bigint, p_holder uuid) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  account public.device_accounts%rowtype;
begin
  account := public.claim_is_current(p_epoch, p_holder);
  update public.device_accounts set last_seen_at = now() where auth_user_id = auth.uid();
  return jsonb_build_object('ok', true, 'epoch', account.claim_epoch);
end;
$$;

-- ── Pushing carton identities ──
--
-- The opening state is NOT taken from the caller. QR_MASTER_OPENING_STATE in @erp/data says a
-- registered carton is PRODUCED at the FACTORY with no location and no first event, and the
-- contract carries only the three fields below -- so the rest is written here, and a client
-- cannot ask for any other opening state because there is no parameter for one.
--
-- `on conflict do nothing` keeps a retried push a no-op, exactly as PostgREST's
-- resolution=ignore-duplicates did. Each row is answered separately so one unsendable carton
-- cannot hold up the rest of a batch.
--
-- No factory check: carton identities are global, by the owner decision recorded in 005.

create or replace function public.push_qr_master(p_epoch bigint, p_holder uuid, p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  account public.device_accounts%rowtype;
  item jsonb;
  outcomes jsonb := '[]'::jsonb;
  inserted int;
begin
  account := public.claim_is_current(p_epoch, p_holder);

  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'ROWS_NOT_AN_ARRAY' using errcode = '22023';
  end if;

  for item in select * from jsonb_array_elements(p_rows) loop
    if item->>'qr_id' is null or item->>'product_variant_id' is null or item->>'created_at' is null then
      outcomes := outcomes || jsonb_build_object('qr_id', item->>'qr_id', 'outcome', 'REFUSED', 'reason', 'PAYLOAD_INCOMPLETE');
      continue;
    end if;

    if not exists (select 1 from public.product_variants pv where pv.id = item->>'product_variant_id') then
      outcomes := outcomes || jsonb_build_object('qr_id', item->>'qr_id', 'outcome', 'REFUSED', 'reason', 'UNKNOWN_PRODUCT_VARIANT');
      continue;
    end if;

    insert into public.qr_master (
      qr_id, product_variant_id, current_status, current_location_type, current_location_id,
      first_event_id, created_at, updated_at
    ) values (
      item->>'qr_id', item->>'product_variant_id', 'PRODUCED', 'FACTORY', null,
      null, item->>'created_at', item->>'created_at'
    )
    on conflict (qr_id) do nothing;

    get diagnostics inserted = row_count;
    outcomes := outcomes || jsonb_build_object(
      'qr_id', item->>'qr_id',
      'outcome', case when inserted > 0 then 'INSERTED' else 'DUPLICATE' end
    );
  end loop;

  return jsonb_build_object('ok', true, 'epoch', account.claim_epoch, 'results', outcomes);
end;
$$;

-- ── Pushing a production scan ──
--
-- Everything 004's insert policy required, plus the two it did not: the workstation and the
-- device. A device may now write only events recorded at its own station and under its own
-- device id, so a copied enrolment cannot attribute work to a machine it is not.
--
-- event_type is written here rather than accepted: PRODUCED is the only scan with a contract.
--
-- EVERY REFUSAL IS PER ROW. Nothing in this loop raises, so one unacceptable event is answered
-- with its own REFUSED outcome and the rest of the batch still lands. That is not a nicety: a
-- raise here is settled by the drain as a transient failure for the whole batch, and transient
-- attempts are unbounded, so a raise does not park one event -- it stalls the outbox.

create or replace function public.push_production_produced(p_epoch bigint, p_holder uuid, p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  account public.device_accounts%rowtype;
  item jsonb;
  outcomes jsonb := '[]'::jsonb;
  inserted int;
begin
  account := public.claim_is_current(p_epoch, p_holder);

  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'ROWS_NOT_AN_ARRAY' using errcode = '22023';
  end if;

  for item in select * from jsonb_array_elements(p_rows) loop
    if item->>'id' is null or item->>'qr_id' is null or item->>'product_variant_id' is null
       or item->>'event_ts_local' is null or item->>'event_date' is null or item->>'event_hour' is null
       or item->>'factory_id' is null or item->>'workstation_id' is null or item->>'device_id' is null
       or item->>'article_snapshot' is null or item->>'color_snapshot' is null
       or item->>'size_snapshot' is null or item->>'serial_snapshot' is null
       or item->>'created_at' is null or item->>'source_app' is null then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'PAYLOAD_INCOMPLETE');
      continue;
    end if;

    if item->>'factory_id' is distinct from account.factory_id then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'WRONG_FACTORY');
      continue;
    end if;

    if item->>'workstation_id' is distinct from account.workstation_id then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'WRONG_WORKSTATION');
      continue;
    end if;

    -- The third identity, and the one 004 never had a way to check: production_events.device_id
    -- is free text with no foreign key, so without this a legitimate claim holder could attribute
    -- work to any device id it liked inside its own factory and workstation. `is distinct from`
    -- so a null submitted value is a mismatch rather than a comparison that answers nothing --
    -- a null is already refused above as PAYLOAD_INCOMPLETE, and this is the second lock.
    if item->>'device_id' is distinct from account.device_id then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'WRONG_DEVICE');
      continue;
    end if;

    -- The carton identity is pushed first for exactly this reason.
    if not exists (select 1 from public.qr_master qm where qm.qr_id = item->>'qr_id') then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'QR_NOT_REGISTERED_YET');
      continue;
    end if;

    -- ONE BAD ROW MUST NOT TAKE THE BATCH WITH IT. Both columns below carry a foreign key that
    -- 002 re-adds, and neither is master data that synchronises: the README's own provisioning
    -- step says the owner must create each computer's operators and the product_variants its
    -- cartons belong to. An unprovisioned one is therefore an expected condition, and without
    -- these checks it raised 23503 out of the whole function -- which the drain settles as a
    -- TRANSIENT failure for every row it was holding, and transient attempts are unbounded. So a
    -- single missing operator did not park one event: it stalled the outbox indefinitely.
    --
    -- Answered per row instead, exactly as push_qr_master answers UNKNOWN_PRODUCT_VARIANT.
    if not exists (select 1 from public.product_variants pv where pv.id = item->>'product_variant_id') then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'UNKNOWN_PRODUCT_VARIANT');
      continue;
    end if;

    -- Nullable in the table and deliberately absent from the PAYLOAD_INCOMPLETE list above: an
    -- event with no operator is valid, so only a named one has to exist.
    if item->>'operator_id' is not null
       and not exists (select 1 from public.operators o where o.id = item->>'operator_id') then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'UNKNOWN_OPERATOR');
      continue;
    end if;

    insert into public.production_events (
      id, qr_id, product_variant_id, event_type, event_ts_local, event_date, event_hour,
      factory_id, workstation_id, operator_id, device_id,
      article_snapshot, color_snapshot, size_snapshot, serial_snapshot,
      metadata_json, created_at, sync_status, source_app
    ) values (
      item->>'id', item->>'qr_id', item->>'product_variant_id', 'PRODUCED',
      item->>'event_ts_local', (item->>'event_date')::date, (item->>'event_hour')::smallint,
      item->>'factory_id', item->>'workstation_id', item->>'operator_id', item->>'device_id',
      item->>'article_snapshot', item->>'color_snapshot', item->>'size_snapshot', item->>'serial_snapshot',
      item->>'metadata_json', item->>'created_at', 'SYNCED', item->>'source_app'
    )
    on conflict (id) do nothing;

    get diagnostics inserted = row_count;
    outcomes := outcomes || jsonb_build_object(
      'id', item->>'id',
      'outcome', case when inserted > 0 then 'INSERTED' else 'DUPLICATE' end
    );
  end loop;

  return jsonb_build_object('ok', true, 'epoch', account.claim_epoch, 'results', outcomes);
end;
$$;

-- ── Who may call what ──
--
-- PostgreSQL grants EXECUTE on a new function to PUBLIC, and Supabase grants it to anon and
-- authenticated as well, so each is revoked by name before anything is given back.

revoke all on function public.current_workstation_id() from public, anon, authenticated;
revoke all on function public.claim_is_current(bigint, uuid) from public, anon, authenticated;
revoke all on function public.refuse_claim_log_change() from public, anon, authenticated;
revoke all on function public.claim_device(text, text, text) from public, anon, authenticated;
revoke all on function public.heartbeat_device(bigint, uuid) from public, anon, authenticated;
revoke all on function public.push_qr_master(bigint, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.push_production_produced(bigint, uuid, jsonb) from public, anon, authenticated;

-- A policy expression is evaluated with the querying role's privileges, so current_workstation_id()
-- must stay callable by a signed-in device exactly as current_factory_id() does.
grant execute on function public.current_workstation_id() to authenticated;
grant execute on function public.claim_device(text, text, text) to authenticated;
grant execute on function public.heartbeat_device(bigint, uuid) to authenticated;
grant execute on function public.push_qr_master(bigint, uuid, jsonb) to authenticated;
grant execute on function public.push_production_produced(bigint, uuid, jsonb) to authenticated;

-- claim_is_current and the log trigger stay owner-only: they are called from inside the
-- functions above, which run as the owner and need no grant of their own.

-- ── The direct way in is closed ──
--
-- THIS IS THE CONTROL THE WHOLE FILE RESTS ON. With no insert privilege there is no second
-- write path, so no future policy, trigger or endpoint can accept a write that skipped the
-- claim. The 004 insert policies stay where they are: harmless, and a second lock if a grant is
-- ever restored by accident.

revoke insert on qr_master, production_events from authenticated;

-- ── The workstation is no longer informational ──
--
-- 004 wrote "Informational for the policies below", and it was. The RPC enforces it now, and
-- this makes the policy say the same thing, so the two cannot drift if a direct grant returns.

drop policy if exists device_inserts_production_events on production_events;
create policy device_inserts_production_events on production_events
for insert to authenticated
with check (
  is_enrolled_device()
  and factory_id = current_factory_id()
  and workstation_id = current_workstation_id()
  and event_type = 'PRODUCED'
  and exists (select 1 from qr_master qm where qm.qr_id = production_events.qr_id)
);

commit;
