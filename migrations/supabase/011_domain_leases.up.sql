-- The write lease: one computer at a time may write each leased domain (docs/37 section W).
--
-- THE OWNER'S MODEL, 2026-10-23. One holder of the write lease per domain; every other computer
-- reads it. Carton and QR flows stay multi-writer, because their identities are deduplicated by
-- construction. Everything else -- raw material store, master data, sales and dispatch, accounts,
-- machine programs, approvals -- has exactly one writer at a time, which is what removes the
-- conflict rules a multi-writer design would need.
--
-- WHAT THIS ADDS, and what it does not.
--   * lease_domains        the domains that have a lease, as rows (like sync_aggregate_types).
--   * domain_leases        one row per domain: which computer holds it, under which epoch.
--   * domain_lease_events  every grant, release and takeover, append-only.
--   * lease_holds()        the question every push RPC of a leased domain asks, in the SAME
--                          transaction as the write it guards. Used from 2b on.
--   * current_leases()     what an enrolled computer reads to know who holds what -- so a reader
--                          shows the domain read-only and its own writes are refused locally first.
--   * release_domain_lease()  the holder gives a domain up, recording where it stopped writing.
--   * grant_domain_lease()    OWNER ONLY. Grants a domain, or takes it over from a holder that is
--                             gone. No client role may call it.
-- It does NOT change any existing push: carton flows are multi-writer and stay unleased.
--
-- A LEASE NAMES A DEVICE, AND THE CLAIM PROVES THE DEVICE. No second token. 006's claim already
-- proves which computer is calling (claim_is_current, in the push's own transaction), so the lease
-- only has to say which device_id may write. A copied enrolment cannot borrow a lease: it cannot
-- hold the claim.
--
-- WHY GRANTING IS OWNER-ONLY. Logins are local to each PC until docs/37 U.2, so the cloud knows
-- machines, not people, and cannot tell an administrator from a storekeeper. Until it can, a lease
-- is granted by the owner from the SQL editor -- or by the agent through MCP, on the owner's word --
-- exactly as enrolment is (docs/36 section 7.6). A device can release a lease it holds, never take
-- one.
--
-- THE CATCH-UP BARRIER. When a domain changes hands, the new holder must not write before it has
-- pulled everything the old holder wrote: otherwise it edits a stale copy. Release and takeover
-- record barrier_seq, the last log position the previous holder wrote. The new holder's computer
-- reads it from current_leases() and refuses its own writes until its pull has passed it. The cloud
-- records the barrier; enforcing it is the client's, because only the client knows how far it has
-- read.
--
-- FORCED TAKEOVER (docs/37 W.3). Granting a held domain to another device takes it over. The old
-- holder's next push of that domain is then refused by lease_holds() and parks in its dead letters:
-- visible, never merged and never silently dropped.
--
-- Paste whole in the SQL editor, TEST project first. Contains revoke, which the MCP tools refuse.

begin;

-- ── The domains that have a lease ──

create table if not exists public.lease_domains (
  domain text primary key,
  note text not null
);
alter table public.lease_domains enable row level security;
revoke all on table public.lease_domains from public, anon, authenticated;

insert into public.lease_domains (domain, note) values
  ('RAW_MATERIAL_STORE', 'Packet label runs, packet movements, stock movements, Dana, receiving and issue sessions.'),
  ('MASTER_DATA', 'Materials and their taxonomy, units, parties, machines, work sections, products.'),
  ('SALES_DISPATCH', 'Gatepasses, sale vouchers, dispatch sessions, sale returns. One domain: a bill is locked to its gatepass.'),
  ('ACCOUNTS', 'Cash and purchase vouchers. Also says where the vouchers are, so ledgers show only there.'),
  ('MACHINE_PROGRAMS', 'Machine programs and their child tables, manual production entries.'),
  ('APPROVALS', 'Stock corrections, removal requests, party claims, access and permission requests.')
on conflict (domain) do nothing;

-- ── Who holds each ──

create table if not exists public.domain_leases (
  domain text primary key references public.lease_domains (domain),
  -- Null: nobody holds it, and nobody may write it.
  holder_device_id text,
  -- Who it was granted to, in words, for the record: "Store PC -- Aslam". Never trusted for anything.
  holder_label text,
  -- Bumps on every grant, release and takeover, so a stale view of the lease is detectable.
  epoch bigint not null default 0,
  granted_at timestamptz,
  released_at timestamptz,
  -- The last log position the previous holder wrote, when it released or was taken over. A new
  -- holder must have pulled at least this far before it writes.
  barrier_seq bigint not null default 0
);
alter table public.domain_leases enable row level security;
revoke all on table public.domain_leases from public, anon, authenticated;

insert into public.domain_leases (domain)
select domain from public.lease_domains
on conflict (domain) do nothing;

-- ── Every change, append-only ──

create table if not exists public.domain_lease_events (
  seq bigserial primary key,
  domain text not null references public.lease_domains (domain),
  event text not null check (event in ('GRANTED', 'RELEASED', 'TAKEN_OVER')),
  device_id text,
  previous_device_id text,
  epoch bigint not null,
  barrier_seq bigint not null,
  -- Who asked for it, in words. Never free text from a client: only grant takes a label, and only
  -- the owner can call grant.
  by_label text,
  logged_at timestamptz not null default now()
);
alter table public.domain_lease_events enable row level security;
revoke all on table public.domain_lease_events from public, anon, authenticated;
revoke all on sequence public.domain_lease_events_seq_seq from public, anon, authenticated;

create or replace function public.refuse_lease_log_change() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'domain_lease_events is append-only';
end;
$$;

drop trigger if exists trg_domain_lease_events_immutable on public.domain_lease_events;
create trigger trg_domain_lease_events_immutable
before update or delete on public.domain_lease_events
for each row execute procedure public.refuse_lease_log_change();

-- ── The question every leased push asks ──

-- The last log position a device wrote. What a new holder must catch up to.
create or replace function public.last_seq_written_by(p_device_id text) returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(max(seq), 0) from public.sync_event_log where origin_device_id = p_device_id;
$$;

-- True when this device holds the domain now, UNDER THE SAME EPOCH the write was made under. Every
-- leased event carries the lease epoch its computer held when it was written. The device alone is
-- not enough: if a lease goes A to B and back to A, writes A made in its first tenure and never
-- pushed would otherwise land on top of B's -- stale edits accepted as current. With the epoch
-- they are refused and park in A's dead letters, which is what docs/37 W.3 promises.
--
-- Called inside a push RPC, after claim_is_current, in the same transaction as the write --
-- `for share` keeps a grant or release from slipping between the check and the write. VOLATILE,
-- not stable: PostgreSQL refuses a row lock inside a non-volatile function.
create or replace function public.lease_holds(p_domain text, p_device_id text, p_lease_epoch bigint) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  lease public.domain_leases%rowtype;
begin
  select * into lease from public.domain_leases where domain = p_domain for share;
  return found
     and lease.holder_device_id is not null
     and lease.holder_device_id = p_device_id
     and lease.epoch = p_lease_epoch;
end;
$$;

-- ── What a computer reads ──

-- Who holds what. Enrolled devices only; an unenrolled account gets nothing. No claim needed: this
-- is a read, and a computer must be able to show "read-only, held by …" before it has claimed.
create or replace function public.current_leases()
returns table (domain text, holder_device_id text, holder_label text, epoch bigint, barrier_seq bigint, granted_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_enrolled_device() then
    return;
  end if;
  return query
    select l.domain, l.holder_device_id, l.holder_label, l.epoch, l.barrier_seq, l.granted_at
      from public.domain_leases l
     order by l.domain;
end;
$$;

-- ── The holder lets go ──

-- The caller proves it is itself (claim) and that it still holds this epoch of the lease. The
-- barrier is where it stopped writing: the next holder catches up to it before writing.
create or replace function public.release_domain_lease(p_epoch bigint, p_holder uuid, p_domain text, p_lease_epoch bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  account public.device_accounts%rowtype;
  lease public.domain_leases%rowtype;
  barrier bigint;
begin
  account := public.claim_is_current(p_epoch, p_holder);
  select * into lease from public.domain_leases where domain = p_domain for update;
  if not found then
    return jsonb_build_object('accepted', false, 'reason', 'UNKNOWN_DOMAIN');
  end if;
  if lease.holder_device_id is distinct from account.device_id then
    return jsonb_build_object('accepted', false, 'reason', 'NOT_HOLDER');
  end if;
  if lease.epoch <> p_lease_epoch then
    return jsonb_build_object('accepted', false, 'reason', 'LEASE_EPOCH_STALE');
  end if;

  barrier := public.last_seq_written_by(account.device_id);
  update public.domain_leases
     set holder_device_id = null, holder_label = null, epoch = epoch + 1,
         released_at = now(), barrier_seq = barrier
   where domain = p_domain;
  insert into public.domain_lease_events (domain, event, device_id, previous_device_id, epoch, barrier_seq, by_label)
  values (p_domain, 'RELEASED', null, account.device_id, lease.epoch + 1, barrier, null);

  return jsonb_build_object('accepted', true, 'epoch', lease.epoch + 1, 'barrierSeq', barrier);
end;
$$;

-- ── The owner grants, or takes over ──

-- OWNER ONLY: no client role may execute it (revoked below). Granting a domain somebody else holds
-- is a takeover, recorded as one, with the barrier at the last position the old holder wrote.
create or replace function public.grant_domain_lease(p_domain text, p_device_id text, p_label text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  lease public.domain_leases%rowtype;
  barrier bigint;
begin
  select * into lease from public.domain_leases where domain = p_domain for update;
  if not found then
    raise exception 'UNKNOWN_DOMAIN: %', p_domain;
  end if;
  -- Only an active, bound device may hold a lease.
  if not exists (
    select 1 from public.device_accounts
     where device_id = p_device_id and is_active and revoked_at is null and workstation_id is not null
  ) then
    raise exception 'NOT_AN_ACTIVE_DEVICE: %', p_device_id;
  end if;
  if lease.holder_device_id = p_device_id then
    return jsonb_build_object('accepted', true, 'unchanged', true, 'epoch', lease.epoch);
  end if;

  -- Released: the barrier stays where the release put it. Held by another device: a takeover,
  -- and the barrier is the last position that device wrote.
  barrier := case
    when lease.holder_device_id is null then lease.barrier_seq
    else public.last_seq_written_by(lease.holder_device_id)
  end;
  update public.domain_leases
     set holder_device_id = p_device_id, holder_label = p_label, epoch = epoch + 1,
         granted_at = now(), released_at = null, barrier_seq = barrier
   where domain = p_domain;
  insert into public.domain_lease_events (domain, event, device_id, previous_device_id, epoch, barrier_seq, by_label)
  values (
    p_domain,
    case when lease.holder_device_id is null then 'GRANTED' else 'TAKEN_OVER' end,
    p_device_id, lease.holder_device_id, lease.epoch + 1, barrier, p_label
  );

  return jsonb_build_object('accepted', true, 'epoch', lease.epoch + 1, 'barrierSeq', barrier,
                            'tookOverFrom', lease.holder_device_id);
end;
$$;

-- ── Who may call what ──
--
-- Everything closed first, then exactly two functions given back to enrolled devices: reading who
-- holds what, and releasing a lease the caller holds. grant_domain_lease, lease_holds and
-- last_seq_written_by stay closed to every client role. A direct grant is not removed by revoking
-- from PUBLIC, so the named roles are revoked too.

revoke all on function public.refuse_lease_log_change() from public, anon, authenticated;
revoke all on function public.last_seq_written_by(text) from public, anon, authenticated;
revoke all on function public.lease_holds(text, text, bigint) from public, anon, authenticated;
revoke all on function public.current_leases() from public, anon, authenticated;
revoke all on function public.release_domain_lease(bigint, uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.grant_domain_lease(text, text, text) from public, anon, authenticated;

grant execute on function public.current_leases() to authenticated;
grant execute on function public.release_domain_lease(bigint, uuid, text, bigint) to authenticated;

commit;

-- PROVED BY verify_applied_state.sql (updated for 011): the three tables exist with RLS and no
-- client grants, current_leases and release_domain_lease are callable by authenticated and not by
-- anon, and grant_domain_lease is callable by neither.
