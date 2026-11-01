-- 023: an account that moves up brings the access it had on its computer, as a SUGGESTION
-- (owner, 2026-11-01; docs/41 section 6).
--
-- WHY. When an existing account moves up it arrives PENDING with no role, and the admin approving it
-- had to pick its role and screens again by hand. Fine for three people, not for twenty. So the claim
-- carries what the account had on its computer -- role, extra screens, job role, authority -- and
-- the cloud keeps it with the person while they wait, where an admin on ANY computer sees it as the
-- starting point of the approval.
--
-- A SUGGESTION, NEVER ACCESS. Nothing reads it to decide what anyone may open: the approval is still
-- the admin's, through admin_set_access, and only what the admin sends becomes the person's access.
-- It is in the PERSON snapshot only while the person is PENDING, and cleared the moment their status
-- changes (a trigger, so admin_set_access keeps 020's body). A malformed suggestion is dropped, not
-- refused: it is a hint, and a bad one must not stop someone moving up.
--
-- claim_existing_account keeps 022's body (the first-admin designation) and gains p_suggested, last
-- and defaulted, so a call without it is unchanged. The first admin carries no suggestion: they are
-- approved already. person_snapshot keeps 020's fields and gains suggestedAccess.
--
-- Run once, in the SQL editor of the TEST project, after 022. Re-running is harmless.

begin;

alter table public.people add column if not exists suggested_access jsonb;

-- What a claim may suggest, read strictly, or null when it is anything else.
create or replace function public.account_suggestion(p jsonb) returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  extras jsonb;
  authority numeric;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return null; end if;
  extras := coalesce(p->'extraPermissions', '[]'::jsonb);
  if jsonb_typeof(extras) <> 'array' or jsonb_array_length(extras) > 100 then return null; end if;
  if exists (select 1 from jsonb_array_elements(extras) e
              where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^[a-z0-9-]{1,64}$') then
    return null;
  end if;
  if jsonb_typeof(p->'roleCode') not in ('null', 'string') then return null; end if;
  if jsonb_typeof(p->'roleCode') = 'string' and (p->>'roleCode') !~ '^[a-z0-9-]{1,64}$' then return null; end if;
  if jsonb_typeof(p->'jobRole') is distinct from 'string' or char_length(p->>'jobRole') > 80 then return null; end if;
  if jsonb_typeof(p->'authorityLevel') is distinct from 'number' then return null; end if;
  authority := (p->>'authorityLevel')::numeric;
  if authority <> trunc(authority) or authority not between 1 and 99 then return null; end if;
  return jsonb_build_object(
    'roleCode', p->'roleCode',
    'extraPermissions', extras,
    'jobRole', btrim(p->>'jobRole'),
    'authorityLevel', authority::int
  );
end;
$$;

-- Cleared the moment the person is decided: a suggestion only ever serves the one approval.
create or replace function public.clear_decided_suggestion() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'PENDING' and new.status <> 'PENDING' then new.suggested_access := null; end if;
  return new;
end;
$$;

drop trigger if exists trg_people_clear_suggestion on public.people;
create trigger trg_people_clear_suggestion
before update of status on public.people
for each row execute procedure public.clear_decided_suggestion();

-- 020's snapshot, with the suggestion while the person waits.
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
    'credentialVersion', p.credential_version,
    'suggestedAccess', case when p.status = 'PENDING' then p.suggested_access else null end
  );
$$;

-- ── Moving an existing local account, with what it had (022's body otherwise) ──

drop function if exists public.claim_existing_account(text, text, text, text);

create or replace function public.claim_existing_account(
  p_local_id text,
  p_email text,
  p_password text,
  p_display_name text,
  p_suggested jsonb default null
) returns jsonb
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
  insert into public.people (id, email, display_name, verifier, status, is_admin, suggested_access, created_on_device, changed_by_device)
  values (p_local_id, btrim(p_email), btrim(p_display_name), extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
          case when first_admin then 'APPROVED' else 'PENDING' end, first_admin,
          case when first_admin then null else public.account_suggestion(p_suggested) end, device.device_id, device.device_id)
  returning * into person;

  insert into public.account_events (action, device_id, subject)
  values (case when first_admin then 'FIRST_ADMIN_CLAIMED' else 'CLAIMED_EXISTING' end, device.device_id, person.id);

  return jsonb_build_object('ok', true, 'person', public.person_snapshot(person))
         || public.issue_person_token(person.id);
end;
$$;

-- ── Who may call what ──

revoke all on function public.account_suggestion(jsonb) from public, anon, authenticated;
revoke all on function public.clear_decided_suggestion() from public, anon, authenticated;
revoke all on function public.person_snapshot(public.people) from public, anon, authenticated;
revoke all on function public.claim_existing_account(text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.claim_existing_account(text, text, text, text, jsonb) to authenticated;

commit;
