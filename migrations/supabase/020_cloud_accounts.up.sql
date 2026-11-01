-- 020: cloud accounts. One account works on every PC; an admin approves it once (docs/41).
--
-- THE FLOW (owner, 2026-11-01). A person signs up on any ENROLLED PC with an email and a password.
-- The account is created here, PENDING, and can do nothing until an admin approves it. The admin
-- sets its role and screens once; that reaches every PC. Revoking it once removes it everywhere.
--
-- WHAT NEVER LEAVES THIS DATABASE. The password verifier (bcrypt -- pgcrypto has no PBKDF2), the
-- failed-attempt count, and the person tokens. No client reads any table here. A PC keeps its own
-- check of a password only for people who signed in on that PC, made locally with its own salt at
-- the moment of a successful sign-in here (docs/41 section 2). No hash or verifier ever replicates.
--
-- WHAT EVERY PC RECEIVES. Two log types, both global (they name no factory):
--   PERSON        a whole snapshot of one person's NON-SECRET facts, at a revision
--   ACCOUNT_ROLE  a whole snapshot of one role (what it may see), at a revision
-- The revision is raised here, by these functions and nothing else, so no PC can overtake a
-- change and there is no last-write-wins on accounts.
--
-- WHO MAY CALL. Every client function first requires an enrolled, active, bound device -- the same
-- test as is_enrolled_device() -- so a fresh install cannot sign anyone up (owner: enrolled PCs
-- only). Admin functions also require a PERSON TOKEN: proof that an approved admin signed in on
-- this PC, not merely that this PC is enrolled. make_first_admin is the owner's alone: no client
-- role has EXECUTE on it.
--
-- REFUSALS ARE CODES. Functions return {ok:false, reason:<CODE>} and never raise with text built
-- from what was typed, so a password cannot reach a log line through an error message.
--
-- Run once, in the SQL editor of the TEST project, after 019. Production stays at 019 until after
-- PC2's cutover (docs/41 section 0). Re-running is harmless.

begin;

-- ── The role catalogue ──
--
-- One catalogue for every PC, replacing each PC's own `roles` table in cloud mode. Codes are the
-- local slugs (users.ts createRole), so a PC's catalogue imports unchanged. A role is never
-- deleted outright: people may still be named against it in history, so it is marked.

create table if not exists public.account_roles (
  role_code text primary key check (role_code ~ '^[a-z0-9-]{1,64}$'),
  role_name text not null check (char_length(btrim(role_name)) between 1 and 60),
  description text check (description is null or char_length(description) <= 300),
  login_policy text not null default 'ALWAYS_LOGGED_IN' check (login_policy in ('ALWAYS_LOGGED_IN', 'DAILY_LOGIN')),
  permissions text[] not null default '{}',
  deleted boolean not null default false,
  revision bigint not null default 1 check (revision >= 1),
  changed_by_device text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_account_roles_name
  on public.account_roles (lower(btrim(role_name))) where not deleted;

alter table public.account_roles enable row level security;
revoke all on public.account_roles from anon, authenticated;

-- ── People ──
--
-- The id is text, not uuid: an existing account keeps the id it has on PC2 (claim_existing_account),
-- so every record that already names it still names the same person. New people get a uuid.

create table if not exists public.people (
  id text primary key default gen_random_uuid()::text check (id ~ '^[A-Za-z0-9_-]{1,64}$'),
  email text not null check (char_length(email) between 3 and 254),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 80),
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED', 'REVOKED')),
  is_admin boolean not null default false,
  role_code text references public.account_roles(role_code),
  extra_permissions text[] not null default '{}',
  job_role text not null default '' check (char_length(job_role) <= 80),
  authority_level integer not null default 10 check (authority_level between 1 and 99),
  -- bcrypt, from extensions.crypt. Never selected into anything a client receives.
  verifier text not null,
  -- Raised on every password change, reset, revocation or rejection. A PC's cached check is valid
  -- only at the version it was made at.
  credential_version integer not null default 1 check (credential_version >= 1),
  revision bigint not null default 1 check (revision >= 1),
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_on_device text,
  changed_by_device text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_people_email on public.people (lower(email));

alter table public.people enable row level security;
revoke all on public.people from anon, authenticated;

-- ── Person tokens ──
--
-- Proof that a person signed in, bound to the device account they signed in on. Only the SHA-256
-- is kept: a leaked row is not a usable token. Twelve hours, then the person signs in again.

create table if not exists public.person_tokens (
  token_hash text primary key,
  person_id text not null references public.people(id) on delete cascade,
  auth_user_id uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_person_tokens_person on public.person_tokens(person_id);

alter table public.person_tokens enable row level security;
revoke all on public.person_tokens from anon, authenticated;

-- ── Who did what, append-only ──

create table if not exists public.account_events (
  seq bigserial primary key,
  action text not null,
  -- The admin who acted, or null for a person acting on themselves / the owner in the SQL editor.
  actor_person_id text,
  device_id text,
  -- The person id or role code acted on.
  subject text not null,
  detail jsonb not null default '{}'::jsonb,
  logged_at timestamptz not null default now()
);

alter table public.account_events enable row level security;
revoke all on public.account_events from anon, authenticated;
revoke all on sequence public.account_events_seq_seq from anon, authenticated;

create or replace function public.refuse_account_event_change() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'account_events is append-only';
end;
$$;

drop trigger if exists trg_account_events_immutable on public.account_events;
create trigger trg_account_events_immutable
before update or delete on public.account_events
for each row execute procedure public.refuse_account_event_change();

-- ── The two log types ──

insert into public.sync_aggregate_types (aggregate_type, factory_scoped, note) values
  ('PERSON', false, 'A person''s non-secret account facts, by revision (020). Global: one account works at every factory.'),
  ('ACCOUNT_ROLE', false, 'A role in the account catalogue, by revision (020). Global, like the people it is assigned to.')
on conflict (aggregate_type) do nothing;

-- ── Snapshots: exactly what a PC is told, and nothing more ──

create or replace function public.person_snapshot(p public.people) returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'personId', p.id,
    'revision', p.revision,
    'email', p.email,
    'displayName', p.display_name,
    'status', p.status,
    'isAdmin', p.is_admin,
    'roleCode', p.role_code,
    'extraPermissions', to_jsonb(p.extra_permissions),
    'jobRole', p.job_role,
    'authorityLevel', p.authority_level,
    'credentialVersion', p.credential_version
  );
$$;

create or replace function public.account_role_snapshot(r public.account_roles) returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'roleCode', r.role_code,
    'revision', r.revision,
    'deleted', r.deleted,
    'name', r.role_name,
    'description', r.description,
    'loginPolicy', r.login_policy,
    'permissions', to_jsonb(r.permissions)
  );
$$;

-- ── Every revision, logged (013's pattern) ──
--
-- Fires on insert and on an update that sets `revision`. Every function below raises the revision
-- exactly when a fact a PC holds changes; a failed sign-in touches only the attempt counter and is
-- never logged.

create or replace function public.log_person_revision() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(777, 1);
  insert into public.sync_event_log (dedupe_key, aggregate_type, aggregate_id, payload, origin_device_id, factory_id)
  values ('PERSON:' || new.id || ':' || new.revision::text, 'PERSON', new.id,
          public.person_snapshot(new), new.changed_by_device, null)
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_people_log on public.people;
create trigger trg_people_log
after insert or update of revision on public.people
for each row execute procedure public.log_person_revision();

create or replace function public.log_account_role_revision() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(777, 1);
  insert into public.sync_event_log (dedupe_key, aggregate_type, aggregate_id, payload, origin_device_id, factory_id)
  values ('ACCOUNT_ROLE:' || new.role_code || ':' || new.revision::text, 'ACCOUNT_ROLE', new.role_code,
          public.account_role_snapshot(new), new.changed_by_device, null)
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_account_roles_log on public.account_roles;
create trigger trg_account_roles_log
after insert or update of revision on public.account_roles
for each row execute procedure public.log_account_role_revision();

-- ── Shared checks ──

-- The calling device, when it is enrolled, active and bound. Null otherwise.
create or replace function public.account_caller() returns public.device_accounts
language sql
stable
security definer
set search_path = ''
as $$
  select d.* from public.device_accounts d
   where d.auth_user_id = auth.uid()
     and d.is_active
     and d.revoked_at is null
     and d.device_id is not null
     and d.workstation_id is not null;
$$;

-- The local rule (users.ts createUserAccount), plus bcrypt's limit: it reads 72 bytes and ignores
-- the rest, so a longer password would be accepted with any ending. Null when acceptable.
create or replace function public.account_password_problem(p_password text) returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_password is null or char_length(p_password) < 8 then 'PASSWORD_TOO_SHORT'
    when octet_length(p_password) > 72 then 'PASSWORD_TOO_LONG'
    when p_password !~ '[A-Za-z]' or p_password !~ '[0-9]' then 'PASSWORD_NEEDS_LETTER_AND_NUMBER'
    else null
  end;
$$;

create or replace function public.account_email_problem(p_email text) returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_email is null or char_length(btrim(p_email)) not between 3 and 254 then 'EMAIL_INVALID'
    when btrim(p_email) !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then 'EMAIL_INVALID'
    else null
  end;
$$;

create or replace function public.account_permissions_ok(p_permissions text[]) returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_permissions is not null
     and cardinality(p_permissions) <= 100
     and not exists (select 1 from unnest(p_permissions) code where code is null or code !~ '^[a-z0-9-]{1,64}$');
$$;

-- A new token for a person on the calling device. Clears that person's expired ones.
create or replace function public.issue_person_token(p_person_id text) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  token text := encode(extensions.gen_random_bytes(32), 'hex');
  expires timestamptz := now() + interval '12 hours';
begin
  delete from public.person_tokens where person_id = p_person_id and expires_at <= now();
  insert into public.person_tokens (token_hash, person_id, auth_user_id, expires_at)
  values (encode(extensions.digest(token, 'sha256'), 'hex'), p_person_id, auth.uid(), expires);
  return jsonb_build_object('token', token, 'expiresAt', expires);
end;
$$;

-- The person behind a token presented by the device it was issued to, while it is live.
create or replace function public.person_from_token(p_token text) returns public.people
language sql
stable
security definer
set search_path = ''
as $$
  select p.* from public.person_tokens t
    join public.people p on p.id = t.person_id
   where t.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
     and t.auth_user_id = auth.uid()
     and t.expires_at > now();
$$;

-- The same, only when that person is an approved admin.
create or replace function public.admin_from_token(p_token text) returns public.people
language sql
stable
security definer
set search_path = ''
as $$
  select p.* from public.person_from_token(p_token) p
   where p.id is not null and p.status = 'APPROVED' and p.is_admin;
$$;

create or replace function public.account_refusal(p_reason text) returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('ok', false, 'reason', p_reason);
$$;

-- ── Signing up ──

create or replace function public.sign_up(p_email text, p_password text, p_display_name text) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  device public.device_accounts;
  problem text;
  person public.people;
begin
  device := public.account_caller();
  if device.auth_user_id is null then return public.account_refusal('NOT_ENROLLED'); end if;

  problem := coalesce(public.account_email_problem(p_email), public.account_password_problem(p_password));
  if problem is not null then return public.account_refusal(problem); end if;
  if p_display_name is null or char_length(btrim(p_display_name)) not between 1 and 80 then
    return public.account_refusal('NAME_INVALID');
  end if;
  if exists (select 1 from public.people where lower(email) = lower(btrim(p_email))) then
    return public.account_refusal('EMAIL_TAKEN');
  end if;

  insert into public.people (email, display_name, verifier, created_on_device, changed_by_device)
  values (btrim(p_email), btrim(p_display_name), extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
          device.device_id, device.device_id)
  returning * into person;

  insert into public.account_events (action, device_id, subject) values ('SIGNED_UP', device.device_id, person.id);

  return jsonb_build_object('ok', true, 'person', public.person_snapshot(person))
         || public.issue_person_token(person.id);
end;
$$;

-- ── Moving an existing local account (docs/41 section 6) ──
--
-- The PC has already checked the password against its own PBKDF2 hash. The account keeps its id and
-- arrives PENDING, like anyone new: an admin approves it. An enrolled PC could claim an id that is
-- not its own; the result is a PENDING request the admin sees with its email, and approving the
-- wrong one is the admin's decision to make, with the facts in front of them.

create or replace function public.claim_existing_account(p_local_id text, p_email text, p_password text, p_display_name text) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  device public.device_accounts;
  problem text;
  person public.people;
begin
  device := public.account_caller();
  if device.auth_user_id is null then return public.account_refusal('NOT_ENROLLED'); end if;

  if p_local_id is null or p_local_id !~ '^[A-Za-z0-9_-]{1,64}$' then return public.account_refusal('ID_INVALID'); end if;
  problem := coalesce(public.account_email_problem(p_email), public.account_password_problem(p_password));
  if problem is not null then return public.account_refusal(problem); end if;
  if p_display_name is null or char_length(btrim(p_display_name)) not between 1 and 80 then
    return public.account_refusal('NAME_INVALID');
  end if;
  if exists (select 1 from public.people where id = p_local_id) then return public.account_refusal('ID_TAKEN'); end if;
  if exists (select 1 from public.people where lower(email) = lower(btrim(p_email))) then
    return public.account_refusal('EMAIL_TAKEN');
  end if;

  insert into public.people (id, email, display_name, verifier, created_on_device, changed_by_device)
  values (p_local_id, btrim(p_email), btrim(p_display_name), extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
          device.device_id, device.device_id)
  returning * into person;

  insert into public.account_events (action, device_id, subject) values ('CLAIMED_EXISTING', device.device_id, person.id);

  return jsonb_build_object('ok', true, 'person', public.person_snapshot(person))
         || public.issue_person_token(person.id);
end;
$$;

-- ── Signing in ──
--
-- Five wrong passwords lock the person for fifteen minutes. An unknown email costs the same bcrypt
-- work as a known one and gets the same answer, so the answer does not say which emails exist.
-- REVOKED and REJECTED are told only to someone who knows the password.

create or replace function public.verify_login(p_email text, p_password text) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  device public.device_accounts;
  person public.people;
begin
  device := public.account_caller();
  if device.auth_user_id is null then return public.account_refusal('NOT_ENROLLED'); end if;

  select * into person from public.people where lower(email) = lower(btrim(coalesce(p_email, ''))) for update;
  if not found then
    perform extensions.crypt(coalesce(p_password, ''), extensions.gen_salt('bf', 10));
    return public.account_refusal('WRONG_CREDENTIALS');
  end if;

  if person.locked_until is not null and person.locked_until > now() then
    return public.account_refusal('LOCKED')
           || jsonb_build_object('retryAfterSeconds', ceil(extract(epoch from person.locked_until - now()))::int);
  end if;

  if person.verifier <> extensions.crypt(coalesce(p_password, ''), person.verifier) then
    if person.failed_attempts + 1 >= 5 then
      update public.people set failed_attempts = 0, locked_until = now() + interval '15 minutes' where id = person.id;
      insert into public.account_events (action, device_id, subject) values ('LOCKED', device.device_id, person.id);
      return public.account_refusal('LOCKED') || jsonb_build_object('retryAfterSeconds', 900);
    end if;
    update public.people set failed_attempts = failed_attempts + 1 where id = person.id;
    return public.account_refusal('WRONG_CREDENTIALS');
  end if;

  update public.people set failed_attempts = 0, locked_until = null, last_login_at = now() where id = person.id;

  if person.status = 'REVOKED' then return public.account_refusal('ACCESS_REVOKED'); end if;
  if person.status = 'REJECTED' then return public.account_refusal('ACCESS_REJECTED'); end if;

  return jsonb_build_object('ok', true, 'person', public.person_snapshot(person))
         || public.issue_person_token(person.id);
end;
$$;

-- ── A person changing their own password ──

create or replace function public.change_password(p_token text, p_current text, p_new text) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  device public.device_accounts;
  person public.people;
  problem text;
begin
  device := public.account_caller();
  if device.auth_user_id is null then return public.account_refusal('NOT_ENROLLED'); end if;

  person := public.person_from_token(p_token);
  if person.id is null or person.status in ('REVOKED', 'REJECTED') then return public.account_refusal('SESSION_EXPIRED'); end if;
  if person.verifier <> extensions.crypt(coalesce(p_current, ''), person.verifier) then
    return public.account_refusal('WRONG_PASSWORD');
  end if;
  problem := public.account_password_problem(p_new);
  if problem is not null then return public.account_refusal(problem); end if;

  update public.people
     set verifier = extensions.crypt(p_new, extensions.gen_salt('bf', 10)),
         credential_version = credential_version + 1,
         revision = revision + 1,
         changed_by_device = device.device_id,
         updated_at = now()
   where id = person.id
  returning * into person;

  -- Other sessions of this person end; this one carries on.
  delete from public.person_tokens
   where person_id = person.id
     and token_hash <> encode(extensions.digest(p_token, 'sha256'), 'hex');

  insert into public.account_events (action, actor_person_id, device_id, subject)
  values ('CHANGED_OWN_PASSWORD', person.id, device.device_id, person.id);

  return jsonb_build_object('ok', true, 'person', public.person_snapshot(person));
end;
$$;

-- ── An admin setting someone's access ──
--
-- Approves, changes, rejects or revokes in one call: the screen sends the whole of what the admin
-- decided, and the cloud judges it. An admin cannot remove their own access, and the last approved
-- admin can never be removed, so the company cannot lock itself out of its own accounts.

create or replace function public.admin_set_access(
  p_token text,
  p_person_id text,
  p_status text,
  p_is_admin boolean,
  p_role_code text,
  p_extra_permissions text[],
  p_job_role text,
  p_authority_level integer
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  device public.device_accounts;
  admin public.people;
  target public.people;
  loses_access boolean;
begin
  device := public.account_caller();
  if device.auth_user_id is null then return public.account_refusal('NOT_ENROLLED'); end if;
  admin := public.admin_from_token(p_token);
  if admin.id is null then return public.account_refusal('ADMIN_REQUIRED'); end if;

  select * into target from public.people where id = p_person_id for update;
  if not found then return public.account_refusal('PERSON_NOT_FOUND'); end if;

  if p_status is null or p_status not in ('PENDING', 'APPROVED', 'REJECTED', 'REVOKED') then
    return public.account_refusal('STATUS_INVALID');
  end if;
  if p_is_admin is null then return public.account_refusal('ADMIN_FLAG_INVALID'); end if;
  if p_role_code is not null
     and not exists (select 1 from public.account_roles where role_code = p_role_code and not deleted) then
    return public.account_refusal('ROLE_NOT_FOUND');
  end if;
  if not public.account_permissions_ok(p_extra_permissions) then return public.account_refusal('PERMISSIONS_INVALID'); end if;
  if p_job_role is null or char_length(p_job_role) > 80 then return public.account_refusal('JOB_ROLE_INVALID'); end if;
  if p_authority_level is null or p_authority_level not between 1 and 99 then
    return public.account_refusal('AUTHORITY_INVALID');
  end if;

  if target.id = admin.id and (p_status <> 'APPROVED' or not p_is_admin) then
    return public.account_refusal('CANNOT_CHANGE_OWN_ACCESS');
  end if;
  if target.status = 'APPROVED' and target.is_admin and not (p_status = 'APPROVED' and p_is_admin)
     and not exists (select 1 from public.people where status = 'APPROVED' and is_admin and id <> target.id) then
    return public.account_refusal('LAST_ADMIN');
  end if;

  loses_access := p_status in ('REVOKED', 'REJECTED') and target.status not in ('REVOKED', 'REJECTED');

  update public.people
     set status = p_status,
         is_admin = p_is_admin,
         role_code = p_role_code,
         extra_permissions = p_extra_permissions,
         job_role = btrim(p_job_role),
         authority_level = p_authority_level,
         credential_version = credential_version + (case when loses_access then 1 else 0 end),
         revision = revision + 1,
         changed_by_device = device.device_id,
         updated_at = now()
   where id = target.id
  returning * into target;

  if loses_access then delete from public.person_tokens where person_id = target.id; end if;

  insert into public.account_events (action, actor_person_id, device_id, subject, detail)
  values ('SET_ACCESS', admin.id, device.device_id, target.id, public.person_snapshot(target));

  return jsonb_build_object('ok', true, 'person', public.person_snapshot(target));
end;
$$;

-- ── An admin resetting someone's password ──

create or replace function public.admin_reset_password(p_token text, p_person_id text, p_new_password text) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  device public.device_accounts;
  admin public.people;
  target public.people;
  problem text;
begin
  device := public.account_caller();
  if device.auth_user_id is null then return public.account_refusal('NOT_ENROLLED'); end if;
  admin := public.admin_from_token(p_token);
  if admin.id is null then return public.account_refusal('ADMIN_REQUIRED'); end if;
  problem := public.account_password_problem(p_new_password);
  if problem is not null then return public.account_refusal(problem); end if;

  update public.people
     set verifier = extensions.crypt(p_new_password, extensions.gen_salt('bf', 10)),
         credential_version = credential_version + 1,
         failed_attempts = 0,
         locked_until = null,
         revision = revision + 1,
         changed_by_device = device.device_id,
         updated_at = now()
   where id = p_person_id
  returning * into target;
  if target.id is null then return public.account_refusal('PERSON_NOT_FOUND'); end if;

  delete from public.person_tokens where person_id = target.id;

  insert into public.account_events (action, actor_person_id, device_id, subject)
  values ('RESET_PASSWORD', admin.id, device.device_id, target.id);

  return jsonb_build_object('ok', true, 'person', public.person_snapshot(target));
end;
$$;

-- ── The role catalogue, edited by an admin ──
--
-- A null code makes a new role, coded from its name exactly as users.ts createRole does. Saving a
-- deleted role's code brings it back.

create or replace function public.admin_save_role(
  p_token text,
  p_role_code text,
  p_name text,
  p_description text,
  p_login_policy text,
  p_permissions text[]
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  device public.device_accounts;
  admin public.people;
  code text;
  saved public.account_roles;
begin
  device := public.account_caller();
  if device.auth_user_id is null then return public.account_refusal('NOT_ENROLLED'); end if;
  admin := public.admin_from_token(p_token);
  if admin.id is null then return public.account_refusal('ADMIN_REQUIRED'); end if;

  if p_name is null or char_length(btrim(p_name)) not between 1 and 60 then return public.account_refusal('NAME_INVALID'); end if;
  if p_description is not null and char_length(p_description) > 300 then return public.account_refusal('DESCRIPTION_INVALID'); end if;
  if p_login_policy is null or p_login_policy not in ('ALWAYS_LOGGED_IN', 'DAILY_LOGIN') then
    return public.account_refusal('LOGIN_POLICY_INVALID');
  end if;
  if not public.account_permissions_ok(p_permissions) then return public.account_refusal('PERMISSIONS_INVALID'); end if;

  code := coalesce(p_role_code, btrim(regexp_replace(lower(btrim(p_name)), '[^a-z0-9]+', '-', 'g'), '-'));
  if code is null or code !~ '^[a-z0-9-]{1,64}$' then return public.account_refusal('ROLE_CODE_INVALID'); end if;

  if exists (select 1 from public.account_roles
              where lower(btrim(role_name)) = lower(btrim(p_name)) and not deleted and role_code <> code) then
    return public.account_refusal('ROLE_NAME_TAKEN');
  end if;

  insert into public.account_roles (role_code, role_name, description, login_policy, permissions, changed_by_device)
  values (code, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), p_login_policy, p_permissions, device.device_id)
  on conflict (role_code) do update
     set role_name = excluded.role_name,
         description = excluded.description,
         login_policy = excluded.login_policy,
         permissions = excluded.permissions,
         deleted = false,
         revision = public.account_roles.revision + 1,
         changed_by_device = excluded.changed_by_device,
         updated_at = now()
  returning * into saved;

  insert into public.account_events (action, actor_person_id, device_id, subject, detail)
  values ('SAVED_ROLE', admin.id, device.device_id, saved.role_code, public.account_role_snapshot(saved));

  return jsonb_build_object('ok', true, 'role', public.account_role_snapshot(saved));
end;
$$;

create or replace function public.admin_delete_role(p_token text, p_role_code text) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  device public.device_accounts;
  admin public.people;
  removed public.account_roles;
begin
  device := public.account_caller();
  if device.auth_user_id is null then return public.account_refusal('NOT_ENROLLED'); end if;
  admin := public.admin_from_token(p_token);
  if admin.id is null then return public.account_refusal('ADMIN_REQUIRED'); end if;

  if exists (select 1 from public.people where role_code = p_role_code) then return public.account_refusal('ROLE_IN_USE'); end if;

  update public.account_roles
     set deleted = true, revision = revision + 1, changed_by_device = device.device_id, updated_at = now()
   where role_code = p_role_code and not deleted
  returning * into removed;
  if removed.role_code is null then return public.account_refusal('ROLE_NOT_FOUND'); end if;

  insert into public.account_events (action, actor_person_id, device_id, subject)
  values ('DELETED_ROLE', admin.id, device.device_id, removed.role_code);

  return jsonb_build_object('ok', true, 'role', public.account_role_snapshot(removed));
end;
$$;

-- Once, while the catalogue is empty: copies a PC's existing roles up (docs/41 section 6). Each
-- element is {code, name, description, loginPolicy, permissions}. All or nothing.
create or replace function public.admin_import_roles(p_token text, p_roles jsonb) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  device public.device_accounts;
  admin public.people;
  item jsonb;
  perms text[];
  imported integer := 0;
begin
  device := public.account_caller();
  if device.auth_user_id is null then return public.account_refusal('NOT_ENROLLED'); end if;
  admin := public.admin_from_token(p_token);
  if admin.id is null then return public.account_refusal('ADMIN_REQUIRED'); end if;

  if exists (select 1 from public.account_roles) then return public.account_refusal('ROLES_ALREADY_PRESENT'); end if;
  if p_roles is null or jsonb_typeof(p_roles) <> 'array' or jsonb_array_length(p_roles) not between 1 and 50 then
    return public.account_refusal('ROLES_INVALID');
  end if;

  for item in select value from jsonb_array_elements(p_roles) loop
    if jsonb_typeof(item) <> 'object' or jsonb_typeof(item->'permissions') is distinct from 'array' then
      raise exception 'ROLES_INVALID';
    end if;
    perms := array(select jsonb_array_elements_text(item->'permissions'));
    if not public.account_permissions_ok(perms) then raise exception 'ROLES_INVALID'; end if;
    -- The table's own checks judge code, name, description and policy; a failure undoes the import.
    insert into public.account_roles (role_code, role_name, description, login_policy, permissions, changed_by_device)
    values (item->>'code', btrim(item->>'name'), nullif(btrim(coalesce(item->>'description', '')), ''),
            coalesce(item->>'loginPolicy', 'ALWAYS_LOGGED_IN'), perms, device.device_id);
    imported := imported + 1;
  end loop;

  insert into public.account_events (action, actor_person_id, device_id, subject, detail)
  values ('IMPORTED_ROLES', admin.id, device.device_id, 'catalogue', jsonb_build_object('count', imported));

  return jsonb_build_object('ok', true, 'imported', imported);
exception
  when others then
    -- Every statement above is undone. The reason is a code, never the payload.
    return public.account_refusal('ROLES_INVALID');
end;
$$;

-- ── The first admin: the owner, in the SQL editor, once per project ──

create or replace function public.make_first_admin(p_email text) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  person public.people;
begin
  if exists (select 1 from public.people where status = 'APPROVED' and is_admin) then
    raise exception 'ADMIN_EXISTS: an approved admin already exists; promote people from the app';
  end if;

  update public.people
     set status = 'APPROVED', is_admin = true, revision = revision + 1, changed_by_device = null, updated_at = now()
   where lower(email) = lower(btrim(p_email))
  returning * into person;
  if person.id is null then
    raise exception 'PERSON_NOT_FOUND: sign up (or sign in once on PC2) with that email first';
  end if;

  insert into public.account_events (action, subject) values ('MADE_FIRST_ADMIN', person.id);
  return public.person_snapshot(person);
end;
$$;

-- ── Who may call what ──
--
-- Everything to nobody first; then the client functions to `authenticated`, which check the device
-- (and, for admin work, the person) themselves. The helpers, the triggers and make_first_admin stay
-- with the owner.

revoke all on function public.refuse_account_event_change() from public, anon, authenticated;
revoke all on function public.person_snapshot(public.people) from public, anon, authenticated;
revoke all on function public.account_role_snapshot(public.account_roles) from public, anon, authenticated;
revoke all on function public.log_person_revision() from public, anon, authenticated;
revoke all on function public.log_account_role_revision() from public, anon, authenticated;
revoke all on function public.account_caller() from public, anon, authenticated;
revoke all on function public.account_password_problem(text) from public, anon, authenticated;
revoke all on function public.account_email_problem(text) from public, anon, authenticated;
revoke all on function public.account_permissions_ok(text[]) from public, anon, authenticated;
revoke all on function public.issue_person_token(text) from public, anon, authenticated;
revoke all on function public.person_from_token(text) from public, anon, authenticated;
revoke all on function public.admin_from_token(text) from public, anon, authenticated;
revoke all on function public.account_refusal(text) from public, anon, authenticated;
revoke all on function public.make_first_admin(text) from public, anon, authenticated;

revoke all on function public.sign_up(text, text, text) from public, anon, authenticated;
revoke all on function public.claim_existing_account(text, text, text, text) from public, anon, authenticated;
revoke all on function public.verify_login(text, text) from public, anon, authenticated;
revoke all on function public.change_password(text, text, text) from public, anon, authenticated;
revoke all on function public.admin_set_access(text, text, text, boolean, text, text[], text, integer) from public, anon, authenticated;
revoke all on function public.admin_reset_password(text, text, text) from public, anon, authenticated;
revoke all on function public.admin_save_role(text, text, text, text, text, text[]) from public, anon, authenticated;
revoke all on function public.admin_delete_role(text, text) from public, anon, authenticated;
revoke all on function public.admin_import_roles(text, jsonb) from public, anon, authenticated;

grant execute on function public.sign_up(text, text, text) to authenticated;
grant execute on function public.claim_existing_account(text, text, text, text) to authenticated;
grant execute on function public.verify_login(text, text) to authenticated;
grant execute on function public.change_password(text, text, text) to authenticated;
grant execute on function public.admin_set_access(text, text, text, boolean, text, text[], text, integer) to authenticated;
grant execute on function public.admin_reset_password(text, text, text) to authenticated;
grant execute on function public.admin_save_role(text, text, text, text, text, text[]) to authenticated;
grant execute on function public.admin_delete_role(text, text) to authenticated;
grant execute on function public.admin_import_roles(text, jsonb) to authenticated;

commit;
