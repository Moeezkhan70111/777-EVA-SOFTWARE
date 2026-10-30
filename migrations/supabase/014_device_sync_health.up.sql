-- Each computer says, in one row, whether it is waiting on anything -- so nobody has to open a
-- Health page on a reader to find out that its stock is incomplete (owner decision, 2026-10-25).
--
-- THE PROBLEM. A revision that waits for a record that never arrives waits for ever, correctly:
-- dropping it would lose it. But until now only that computer's own Health page said so, and nobody
-- opens a Health page on the boss's PC. A material could sit incomplete for a week while its stock
-- looked authoritative.
--
-- ONE ROW PER COMPUTER, OVERWRITTEN -- NEVER A LOG. device_sync_health is keyed by device_id and
-- report_sync_health upserts it, so the table holds exactly as many rows as there are enrolled
-- computers, whatever the pass rate. A computer reports only when its health changes, or as a
-- keepalive every 15 minutes, so a healthy computer writes about 96 times a day, not 1,440. A row
-- whose reported_at is hours old means that computer is off or offline -- worth seeing too. There is
-- no history here; a trend, if ever wanted, is a separate and bounded decision.
--
-- WHAT A ROW SAYS
--   waiting / stuck / stale   events this computer holds back for a prerequisite: under an hour,
--                             over an hour, over a day. Stale stays until the cause is fixed.
--   oldest_waiting_since      when the longest wait began
--   sample                    up to five of them, in words: what waits, for what, since when
--   dead_letters              this computer's own work the cloud refused for good
--   unsent_marks              master-data changes made without a lease epoch (before sync was set
--                             up), which only the backfill will send
--
-- WHO MAY READ IT. Enrolled computers of the same factory: the store PC shows "the boss's PC has
-- waited two days for category c-17" beside a Send again button. It holds counts and record names
-- -- master data every computer of the factory already holds -- and nothing secret.
--
-- Requires 006 (the claim). Paste whole in the SQL editor, TEST project first. Contains revoke,
-- which the MCP tools refuse.

begin;

create table if not exists public.device_sync_health (
  device_id text primary key,
  factory_id text not null references public.factories (id),
  -- The enrolment's label, copied at report time so a reader of this table needs nothing else.
  label text not null,
  waiting integer not null default 0 check (waiting >= 0),
  stuck integer not null default 0 check (stuck >= 0),
  stale integer not null default 0 check (stale >= 0),
  oldest_waiting_since timestamptz,
  sample jsonb not null default '[]'::jsonb check (jsonb_typeof(sample) = 'array' and jsonb_array_length(sample) <= 5),
  dead_letters integer not null default 0 check (dead_letters >= 0),
  unsent_marks integer not null default 0 check (unsent_marks >= 0),
  reported_at timestamptz not null default now()
);
alter table public.device_sync_health enable row level security;
revoke all on table public.device_sync_health from public, anon, authenticated;
grant select on table public.device_sync_health to authenticated;

drop policy if exists device_reads_sync_health on public.device_sync_health;
create policy device_reads_sync_health on public.device_sync_health
for select to authenticated
using (public.is_enrolled_device() and factory_id = public.current_factory_id());

-- A count from a client: a whole number, not negative, not absurd. Anything else is refused whole.
create or replace function public.sync_health_count(p_value jsonb) returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_value) = 'number' and (p_value #>> '{}') ~ '^[0-9]{1,7}$' then (p_value #>> '{}')::integer
    else null
  end;
$$;

create or replace function public.report_sync_health(p_epoch bigint, p_holder uuid, p_report jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  account public.device_accounts%rowtype;
  v_waiting integer;
  v_stuck integer;
  v_stale integer;
  v_dead integer;
  v_unsent integer;
  v_oldest timestamptz;
  v_sample jsonb;
  item jsonb;
begin
  account := public.claim_is_current(p_epoch, p_holder);

  if jsonb_typeof(p_report) is distinct from 'object' or octet_length(p_report::text) > 8192 then
    return jsonb_build_object('accepted', false, 'reason', 'REPORT_UNREADABLE');
  end if;
  v_waiting := public.sync_health_count(p_report->'waiting');
  v_stuck := public.sync_health_count(p_report->'stuck');
  v_stale := public.sync_health_count(p_report->'stale');
  v_dead := public.sync_health_count(p_report->'deadLetters');
  v_unsent := public.sync_health_count(p_report->'unsentMarks');
  if v_waiting is null or v_stuck is null or v_stale is null or v_dead is null or v_unsent is null then
    return jsonb_build_object('accepted', false, 'reason', 'REPORT_UNREADABLE');
  end if;

  if p_report->>'oldestWaitingSince' is null then
    v_oldest := null;
  elsif (p_report->>'oldestWaitingSince') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$' then
    v_oldest := (p_report->>'oldestWaitingSince')::timestamptz;
  else
    return jsonb_build_object('accepted', false, 'reason', 'REPORT_UNREADABLE');
  end if;

  -- Up to five items, each three short strings and, optionally, the record that would end the wait
  -- (needs, "TYPE:id"). Nothing else is kept from the client.
  v_sample := '[]'::jsonb;
  if jsonb_typeof(p_report->'sample') = 'array' then
    for item in select * from jsonb_array_elements(p_report->'sample') limit 5 loop
      if jsonb_typeof(item) = 'object'
         and jsonb_typeof(item->'subject') = 'string' and length(item->>'subject') <= 200
         and jsonb_typeof(item->'waitingFor') = 'string' and length(item->>'waitingFor') <= 200
         and jsonb_typeof(item->'since') = 'string' and length(item->>'since') <= 40 then
        v_sample := v_sample || jsonb_build_array(jsonb_build_object(
          'subject', item->>'subject', 'waitingFor', item->>'waitingFor', 'since', item->>'since')
          || case when jsonb_typeof(item->'needs') = 'string' and length(item->>'needs') <= 200
                  then jsonb_build_object('needs', item->>'needs') else '{}'::jsonb end);
      end if;
    end loop;
  end if;

  insert into public.device_sync_health (
    device_id, factory_id, label, waiting, stuck, stale, oldest_waiting_since, sample, dead_letters, unsent_marks, reported_at
  ) values (
    account.device_id, account.factory_id, account.label, v_waiting, v_stuck, v_stale, v_oldest, v_sample, v_dead, v_unsent, now()
  )
  on conflict (device_id) do update set
    factory_id = excluded.factory_id, label = excluded.label, waiting = excluded.waiting, stuck = excluded.stuck,
    stale = excluded.stale, oldest_waiting_since = excluded.oldest_waiting_since, sample = excluded.sample,
    dead_letters = excluded.dead_letters, unsent_marks = excluded.unsent_marks, reported_at = excluded.reported_at;

  return jsonb_build_object('accepted', true);
end;
$$;

revoke all on function public.sync_health_count(jsonb) from public, anon, authenticated;
revoke all on function public.report_sync_health(bigint, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.report_sync_health(bigint, uuid, jsonb) to authenticated;

commit;
