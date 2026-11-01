-- 022: the first admin is named before they exist, at the computer they will claim from
-- (owner, 2026-11-01; docs/41 section 12).
--
-- THE ORDER THIS SERVES. Applying a migration must never be what signs a store out. So production
-- goes: apply 020-022 (nothing changes anywhere) -> name the first admin here -> the owner, standing
-- at PC2, signs in as today and presses "Switch to cloud accounts" -> their account moves up as an
-- approved admin -> the switch signs everyone else out -> the owner approves people. An admin exists
-- before anyone is locked out, and someone is at the machine when it happens.
--
-- WHY THE COMPUTER IS PART OF THE NAME. 020's make_first_admin needs the person to exist already,
-- but here they do not until the button is pressed. Naming only an email would let anyone at ANY
-- enrolled computer who types the owner's email become the first admin. So the designation names
-- the email AND the enrolled device the claim must come from. A claim of that email anywhere else
-- arrives PENDING like any other, and the designation is used once, and only while no approved
-- admin exists.
--
--   select public.make_first_admin('<email>',
--     (select device_id from public.device_accounts where label = '<PC2''s label>'));
--
-- 020's one-argument call still works for someone who already exists (the second argument defaults
-- to null). Like 020's, no client role may call it: it is the owner's, in the SQL editor.
--
-- sign_up and claim_existing_account are re-defined here with their 020 bodies unchanged except for
-- the designation. Run once, in the SQL editor of the TEST project, after 021. Re-running is harmless.

begin;

-- ── The designation: at most one, and nobody reads it ──

create table if not exists public.first_admin_designation (
  singleton boolean primary key default true check (singleton),
  email text not null check (char_length(email) between 3 and 254),
  device_id text not null,
  designated_at timestamptz not null default now()
);

alter table public.first_admin_designation enable row level security;
revoke all on public.first_admin_designation from anon, authenticated;

-- Takes the designation when this email, at this device, is the one named and no approved admin
-- exists yet. True exactly once; the row is gone after it.
create or replace function public.take_first_admin_designation(p_email text, p_device_id text) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.people where status = 'APPROVED' and is_admin) then return false; end if;
  delete from public.first_admin_designation
   where lower(email) = lower(btrim(coalesce(p_email, ''))) and device_id = p_device_id;
  return found;
end;
$$;

-- ── Naming the first admin (replaces 020's) ──

drop function if exists public.make_first_admin(text);

create or replace function public.make_first_admin(p_email text, p_device_id text default null) returns jsonb
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

  -- Someone who already exists: approved now, as in 020.
  update public.people
     set status = 'APPROVED', is_admin = true, revision = revision + 1, changed_by_device = null, updated_at = now()
   where lower(email) = lower(btrim(p_email))
  returning * into person;
  if person.id is not null then
    insert into public.account_events (action, subject) values ('MADE_FIRST_ADMIN', person.id);
    return public.person_snapshot(person);
  end if;

  -- Someone who will claim at one computer: named, with that computer.
  if p_device_id is null then
    raise exception 'PERSON_NOT_FOUND: nobody has that email yet; name the computer they will claim from as the second argument';
  end if;
  if not exists (select 1 from public.device_accounts
                  where device_id = p_device_id and is_active and revoked_at is null) then
    raise exception 'DEVICE_NOT_ENROLLED: no enrolled, active computer has that device id';
  end if;
  insert into public.first_admin_designation (singleton, email, device_id) values (true, btrim(p_email), p_device_id)
  on conflict (singleton) do update set email = excluded.email, device_id = excluded.device_id, designated_at = now();
  insert into public.account_events (action, device_id, subject) values ('NAMED_FIRST_ADMIN', p_device_id, btrim(p_email));
  return jsonb_build_object('named', btrim(p_email), 'deviceId', p_device_id);
end;
$$;

-- ── Signing up, with the designation (020's body otherwise) ──

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
  first_admin boolean;
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

  first_admin := public.take_first_admin_designation(p_email, device.device_id);
  insert into public.people (email, display_name, verifier, status, is_admin, created_on_device, changed_by_device)
  values (btrim(p_email), btrim(p_display_name), extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
          case when first_admin then 'APPROVED' else 'PENDING' end, first_admin, device.device_id, device.device_id)
  returning * into person;

  insert into public.account_events (action, device_id, subject)
  values (case when first_admin then 'FIRST_ADMIN_CLAIMED' else 'SIGNED_UP' end, device.device_id, person.id);

  return jsonb_build_object('ok', true, 'person', public.person_snapshot(person))
         || public.issue_person_token(person.id);
end;
$$;

-- ── Moving an existing local account, with the designation (020's body otherwise) ──

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
  first_admin boolean;
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

  first_admin := public.take_first_admin_designation(p_email, device.device_id);
  insert into public.people (id, email, display_name, verifier, status, is_admin, created_on_device, changed_by_device)
  values (p_local_id, btrim(p_email), btrim(p_display_name), extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
          case when first_admin then 'APPROVED' else 'PENDING' end, first_admin, device.device_id, device.device_id)
  returning * into person;

  insert into public.account_events (action, device_id, subject)
  values (case when first_admin then 'FIRST_ADMIN_CLAIMED' else 'CLAIMED_EXISTING' end, device.device_id, person.id);

  return jsonb_build_object('ok', true, 'person', public.person_snapshot(person))
         || public.issue_person_token(person.id);
end;
$$;

-- ── Who may call what ──

revoke all on function public.take_first_admin_designation(text, text) from public, anon, authenticated;
revoke all on function public.make_first_admin(text, text) from public, anon, authenticated;
revoke all on function public.sign_up(text, text, text) from public, anon, authenticated;
revoke all on function public.claim_existing_account(text, text, text, text) from public, anon, authenticated;
grant execute on function public.sign_up(text, text, text) to authenticated;
grant execute on function public.claim_existing_account(text, text, text, text) to authenticated;

commit;
