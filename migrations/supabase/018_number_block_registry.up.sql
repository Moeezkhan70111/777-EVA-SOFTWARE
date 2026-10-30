-- 018: the number-block registry. The cloud refuses a second computer on a block already taken.
--
-- THE INCIDENT (docs/39 section 4.4). Every computer numbers its documents and QR serials inside
-- its own block (packages/data numberRange.ts): block 1 is 1-99,999, block 2 is 100,000-199,999,
-- and so on. PC3 was made by copying PC2's database, so both held block 1 and both issued the same
-- codes and serials. numberRange.ts says it plainly: nothing on one computer can stop two
-- computers being given the same block, because there is no central authority to ask. The leases
-- (011) do not stop it either: they decide who may write NOW, not which numbers a computer owns.
--
-- THE FIX. The cloud is that authority. It records which computer holds each block, and:
--
--   1. claim_device takes the computer's block. The first computer to claim a block holds it, for
--      good. Another computer claiming the same block is refused NUMBER_BLOCK_TAKEN; a computer
--      claiming a different block from the one it holds is refused NUMBER_BLOCK_CHANGED (its
--      database was swapped); a claim with no block is refused NUMBER_BLOCK_MISSING.
--   2. claim_is_current, which every write runs in its own transaction, refuses a device that holds
--      no block: NUMBER_BLOCK_NOT_REGISTERED. A refused claim on its own would be theatre (006):
--      it is the writes that must refuse. This also catches a process that claimed before 018.
--
-- A refused computer sends nothing at all. Its local work is untouched and stays queued: a
-- refused claim is an answer about the device, never about an event (006).
--
-- A BLOCK NEVER MOVES BY ITSELF. Not when its holder is revoked, not when it stops syncing. Numbers
-- the old holder issued are in its documents and on printed stickers, and a new holder that
-- does not hold those documents would issue them again. The one legitimate move -- a block going to
-- the computer that now holds its predecessor's data -- is the owner's decision, made in the SQL
-- editor with reassign_number_block and a reason, and recorded.
--
-- GLOBAL, NOT PER FACTORY. Carton serials come from the block too (SERIAL_BLOCK_SIZE), and carton
-- identities are global (005), so two factories on one block would collide on qr_master.
--
-- Nothing here is readable by a client: a device learns only its own answer. A refusal does not
-- name the computer holding the block -- device labels carry people's addresses.
--
-- Run once, in the SQL editor, after 017. Re-running is harmless.

begin;

-- ── The registry ──

create table if not exists public.number_blocks (
  block integer primary key check (block >= 1),
  device_id text not null,
  -- The enrolment that registered it, or that the owner reassigned it to.
  auth_user_id uuid not null,
  registered_at timestamptz not null default now()
);

-- A computer holds one block. Its block never changes locally (numberRange.ts
-- PROTECTED_NUMBER_SETTING_KEYS), so a second one is a swapped database.
create unique index if not exists idx_number_blocks_device on public.number_blocks(device_id);

alter table public.number_blocks enable row level security;
revoke all on public.number_blocks from anon, authenticated;

-- ── Its history ──
--
-- Every registration and every reassignment, append-only. Refusals are claim refusals and go
-- where every other one goes, device_claim_events.

create table if not exists public.number_block_events (
  seq bigserial primary key,
  block integer not null,
  device_id text not null,
  event text not null check (event in ('REGISTERED', 'REASSIGNED')),
  -- REASSIGNED only: who held it before, and the owner's reason.
  previous_device_id text,
  reason text,
  logged_at timestamptz not null default now()
);

alter table public.number_block_events enable row level security;
revoke all on public.number_block_events from anon, authenticated;
revoke all on sequence public.number_block_events_seq_seq from anon, authenticated;

create or replace function public.refuse_number_block_log_change() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'number_block_events is append-only';
end;
$$;

revoke all on function public.refuse_number_block_log_change() from public, anon, authenticated;

drop trigger if exists trg_number_block_events_immutable on public.number_block_events;
create trigger trg_number_block_events_immutable
before update or delete on public.number_block_events
for each row execute procedure public.refuse_number_block_log_change();

-- ── Claiming, with the block ──
--
-- 006's claim, unchanged up to the bump, with the block decided just before it: a refused block
-- takes no epoch. The old three-argument function is dropped so there is one claim_device. A
-- client that does not send p_number_block reaches this one with null and is refused
-- NUMBER_BLOCK_MISSING -- a version from before 018 cannot sync, deliberately.

drop function if exists public.claim_device(text, text, text);

create or replace function public.claim_device(
  p_device_id text,
  p_workstation_id text,
  p_app_version text default null,
  p_number_block integer default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  account public.device_accounts%rowtype;
  held public.number_blocks%rowtype;
  new_epoch bigint;
  new_holder uuid;
begin
  -- No caller, no refusal to record (006).
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

  -- THE NUMBER BLOCK (018). Decided before the bump, so a refusal takes no epoch.
  if p_number_block is null or p_number_block < 1 then
    insert into public.device_claim_events (auth_user_id, device_id, workstation_id, event, detail, app_version)
    values (auth.uid(), account.device_id, account.workstation_id, 'REFUSED', 'NUMBER_BLOCK_MISSING', p_app_version);
    return jsonb_build_object('ok', false, 'reason', 'NUMBER_BLOCK_MISSING');
  end if;

  select * into held from public.number_blocks where device_id = account.device_id for update;
  if found and held.block <> p_number_block then
    insert into public.device_claim_events (auth_user_id, device_id, workstation_id, event, detail, app_version)
    values (auth.uid(), account.device_id, account.workstation_id, 'REFUSED', 'NUMBER_BLOCK_CHANGED', p_app_version);
    return jsonb_build_object('ok', false, 'reason', 'NUMBER_BLOCK_CHANGED', 'block', held.block);
  end if;

  if not found then
    -- Two computers claiming one block at once: the second waits on the first's insert, then
    -- inserts nothing, and is refused.
    insert into public.number_blocks (block, device_id, auth_user_id)
    values (p_number_block, account.device_id, auth.uid())
    on conflict (block) do nothing;
    if not found then
      insert into public.device_claim_events (auth_user_id, device_id, workstation_id, event, detail, app_version)
      values (auth.uid(), account.device_id, account.workstation_id, 'REFUSED', 'NUMBER_BLOCK_TAKEN', p_app_version);
      return jsonb_build_object('ok', false, 'reason', 'NUMBER_BLOCK_TAKEN', 'block', p_number_block);
    end if;
    insert into public.number_block_events (block, device_id, event)
    values (p_number_block, account.device_id, 'REGISTERED');
  end if;

  new_epoch := account.claim_epoch + 1;
  new_holder := gen_random_uuid();

  update public.device_accounts
     set claim_epoch = new_epoch,
         claim_holder = new_holder,
         last_seen_at = now(),
         last_seen_version = p_app_version
   where auth_user_id = auth.uid();

  if account.claim_holder is not null then
    insert into public.device_claim_events (auth_user_id, device_id, workstation_id, event, claim_epoch, detail, app_version)
    values (auth.uid(), account.device_id, account.workstation_id, 'SUPERSEDED', account.claim_epoch, 'CLAIMED_AGAIN', p_app_version);
  end if;

  insert into public.device_claim_events (auth_user_id, device_id, workstation_id, event, claim_epoch, app_version)
  values (auth.uid(), account.device_id, account.workstation_id, 'CLAIMED', new_epoch, p_app_version);

  return jsonb_build_object('ok', true, 'epoch', new_epoch, 'holder', new_holder);
end;
$$;

revoke all on function public.claim_device(text, text, text, integer) from public, anon, authenticated;
grant execute on function public.claim_device(text, text, text, integer) to authenticated;

-- ── The check every write makes, with the block ──
--
-- 006's, unchanged, and one more refusal: a device holding no block writes nothing. Still a raise
-- with 42501, so the client reads it as a refusal of the device, not of the event.

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
  if not exists (select 1 from public.number_blocks where device_id = account.device_id) then
    raise exception 'NUMBER_BLOCK_NOT_REGISTERED' using errcode = '42501';
  end if;

  return account;
end;
$$;

revoke all on function public.claim_is_current(bigint, uuid) from public, anon, authenticated;

-- ── The owner's one way to move a block ──
--
-- SQL editor only: no client role may call it. For a block going to the computer that now holds
-- its previous holder's data (as block 1 went from PC1 to PC2). It refuses a computer that is not
-- enrolled and active, one that already holds another block, and a move without a reason.

create or replace function public.reassign_number_block(p_block integer, p_device_id text, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target public.device_accounts%rowtype;
  previous text;
begin
  if p_block is null or p_block < 1 then
    raise exception 'BLOCK_INVALID';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'REASON_REQUIRED: say why block % moves, in at least 10 characters', p_block;
  end if;

  select * into target from public.device_accounts
   where device_id = p_device_id and is_active and revoked_at is null;
  if not found then
    raise exception 'NOT_AN_ACTIVE_DEVICE: %', p_device_id;
  end if;
  if exists (select 1 from public.number_blocks where device_id = p_device_id and block <> p_block) then
    raise exception 'DEVICE_HOLDS_ANOTHER_BLOCK: %', p_device_id;
  end if;

  select device_id into previous from public.number_blocks where block = p_block for update;
  if previous is not distinct from p_device_id then
    return jsonb_build_object('ok', true, 'unchanged', true, 'block', p_block);
  end if;

  insert into public.number_blocks (block, device_id, auth_user_id)
  values (p_block, p_device_id, target.auth_user_id)
  on conflict (block) do update
    set device_id = excluded.device_id, auth_user_id = excluded.auth_user_id, registered_at = now();

  insert into public.number_block_events (block, device_id, event, previous_device_id, reason)
  values (p_block, p_device_id, 'REASSIGNED', previous, trim(p_reason));

  return jsonb_build_object('ok', true, 'block', p_block, 'from', previous, 'to', p_device_id);
end;
$$;

revoke all on function public.reassign_number_block(integer, text, text) from public, anon, authenticated;

commit;
