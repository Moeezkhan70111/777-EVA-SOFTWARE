-- 021: permission requests go to the cloud, like everything else about access (docs/41 section 8).
--
-- THE HOLE IT CLOSES. Under cloud accounts a person's role and screens come from here. A request
-- for one more screen that was approved by one PC's local admin, and nowhere else, would grant
-- what the cloud never authorised -- the same hole as every install making its own first admin.
-- So the request is made here, decided here, and an approval reaches every PC as the person's next
-- PERSON revision (020).
--
-- EVERY PC SEES THE REQUESTS. They are logged as a third account type, PERMISSION_REQUEST, by
-- revision, so an admin's PC lists them wherever it is, even offline. Asking and deciding need the
-- internet, like every other account change.
--
-- Uses 020's helpers: account_caller, person_from_token, admin_from_token, account_refusal,
-- person_snapshot. Refusals are codes, as in 020.
--
-- Run once, in the SQL editor of the TEST project, after 020. Production stays at 019 until after
-- PC2's cutover. Re-running is harmless.

begin;

create table if not exists public.account_permission_requests (
  id text primary key default gen_random_uuid()::text,
  person_id text not null references public.people(id),
  permission_code text not null check (permission_code ~ '^[a-z0-9-]{1,64}$'),
  reason text check (reason is null or char_length(reason) <= 300),
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text references public.people(id),
  review_notes text check (review_notes is null or char_length(review_notes) <= 300),
  revision bigint not null default 1 check (revision >= 1),
  changed_by_device text
);

-- One pending request per person and screen, as the local flow behaves.
create unique index if not exists idx_account_permission_requests_pending
  on public.account_permission_requests (person_id, permission_code) where status = 'PENDING';

alter table public.account_permission_requests enable row level security;
revoke all on public.account_permission_requests from anon, authenticated;

insert into public.sync_aggregate_types (aggregate_type, factory_scoped, note) values
  ('PERMISSION_REQUEST', false, 'A request for one more screen, and its decision, by revision (021). Global, like the person who asked.')
on conflict (aggregate_type) do nothing;

create or replace function public.permission_request_snapshot(q public.account_permission_requests) returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'requestId', q.id,
    'revision', q.revision,
    'personId', q.person_id,
    'permissionCode', q.permission_code,
    'reason', q.reason,
    'status', q.status,
    'requestedAt', q.requested_at,
    'reviewedAt', q.reviewed_at,
    'reviewedBy', q.reviewed_by,
    'reviewNotes', q.review_notes
  );
$$;

create or replace function public.log_permission_request_revision() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(777, 1);
  insert into public.sync_event_log (dedupe_key, aggregate_type, aggregate_id, payload, origin_device_id, factory_id)
  values ('PERMISSION_REQUEST:' || new.id || ':' || new.revision::text, 'PERMISSION_REQUEST', new.id,
          public.permission_request_snapshot(new), new.changed_by_device, null)
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_account_permission_requests_log on public.account_permission_requests;
create trigger trg_account_permission_requests_log
after insert or update of revision on public.account_permission_requests
for each row execute procedure public.log_permission_request_revision();

-- ── Asking ──

create or replace function public.request_permission(p_token text, p_permission_code text, p_reason text) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  device public.device_accounts;
  person public.people;
  request public.account_permission_requests;
begin
  device := public.account_caller();
  if device.auth_user_id is null then return public.account_refusal('NOT_ENROLLED'); end if;
  person := public.person_from_token(p_token);
  if person.id is null then return public.account_refusal('SESSION_EXPIRED'); end if;
  if person.status <> 'APPROVED' then return public.account_refusal('ACCESS_NOT_APPROVED'); end if;
  if p_permission_code is null or p_permission_code !~ '^[a-z0-9-]{1,64}$' then
    return public.account_refusal('PERMISSION_INVALID');
  end if;
  if p_reason is not null and char_length(p_reason) > 300 then return public.account_refusal('REASON_INVALID'); end if;

  select * into request from public.account_permission_requests
   where person_id = person.id and permission_code = p_permission_code and status = 'PENDING';
  if found then
    return jsonb_build_object('ok', true, 'request', public.permission_request_snapshot(request));
  end if;

  insert into public.account_permission_requests (person_id, permission_code, reason, changed_by_device)
  values (person.id, p_permission_code, nullif(btrim(coalesce(p_reason, '')), ''), device.device_id)
  returning * into request;

  insert into public.account_events (action, actor_person_id, device_id, subject, detail)
  values ('REQUESTED_PERMISSION', person.id, device.device_id, person.id,
          jsonb_build_object('requestId', request.id, 'permissionCode', request.permission_code));

  return jsonb_build_object('ok', true, 'request', public.permission_request_snapshot(request));
end;
$$;

-- ── Deciding ──
--
-- Approving adds the screen to the person's extra permissions and raises their revision, so every
-- PC learns of it through PERSON as well as PERMISSION_REQUEST. A request for a person who has since
-- lost access can still be declined, never approved.

create or replace function public.admin_review_permission_request(p_token text, p_request_id text, p_decision text, p_notes text) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  device public.device_accounts;
  admin public.people;
  request public.account_permission_requests;
  person public.people;
begin
  device := public.account_caller();
  if device.auth_user_id is null then return public.account_refusal('NOT_ENROLLED'); end if;
  admin := public.admin_from_token(p_token);
  if admin.id is null then return public.account_refusal('ADMIN_REQUIRED'); end if;
  if p_decision is null or p_decision not in ('APPROVED', 'REJECTED') then return public.account_refusal('DECISION_INVALID'); end if;
  if p_notes is not null and char_length(p_notes) > 300 then return public.account_refusal('NOTES_INVALID'); end if;

  select * into request from public.account_permission_requests where id = p_request_id for update;
  if not found or request.status <> 'PENDING' then return public.account_refusal('REQUEST_NOT_PENDING'); end if;

  if p_decision = 'APPROVED' then
    select * into person from public.people where id = request.person_id for update;
    if person.status <> 'APPROVED' then return public.account_refusal('ACCESS_NOT_APPROVED'); end if;
    if not (request.permission_code = any (person.extra_permissions)) then
      if cardinality(person.extra_permissions) >= 100 then return public.account_refusal('PERMISSIONS_INVALID'); end if;
      update public.people
         set extra_permissions = array_append(extra_permissions, request.permission_code),
             revision = revision + 1,
             changed_by_device = device.device_id,
             updated_at = now()
       where id = person.id;
    end if;
  end if;

  update public.account_permission_requests
     set status = p_decision,
         reviewed_at = now(),
         reviewed_by = admin.id,
         review_notes = nullif(btrim(coalesce(p_notes, '')), ''),
         revision = revision + 1,
         changed_by_device = device.device_id
   where id = request.id
  returning * into request;

  insert into public.account_events (action, actor_person_id, device_id, subject, detail)
  values ('REVIEWED_PERMISSION', admin.id, device.device_id, request.person_id,
          jsonb_build_object('requestId', request.id, 'permissionCode', request.permission_code, 'decision', p_decision));

  return jsonb_build_object('ok', true, 'request', public.permission_request_snapshot(request));
end;
$$;

-- ── Who may call what ──

revoke all on function public.permission_request_snapshot(public.account_permission_requests) from public, anon, authenticated;
revoke all on function public.log_permission_request_revision() from public, anon, authenticated;
revoke all on function public.request_permission(text, text, text) from public, anon, authenticated;
revoke all on function public.admin_review_permission_request(text, text, text, text) from public, anon, authenticated;

grant execute on function public.request_permission(text, text, text) to authenticated;
grant execute on function public.admin_review_permission_request(text, text, text, text) to authenticated;

commit;
