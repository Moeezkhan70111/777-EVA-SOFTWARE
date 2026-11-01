-- Undoes 023: claims no longer carry a suggestion, and the PERSON snapshot returns to 020's fields.
-- claim_existing_account and person_snapshot are restored from 022 and 020 exactly (extracted, not
-- retyped). Suggestions not yet used are lost with their column; the approvals themselves are not.

begin;

drop trigger if exists trg_people_clear_suggestion on public.people;
drop function if exists public.clear_decided_suggestion();

revoke all on function public.claim_existing_account(text, text, text, text, jsonb) from public, anon, authenticated;
drop function if exists public.claim_existing_account(text, text, text, text, jsonb);

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

drop function if exists public.account_suggestion(jsonb);
alter table public.people drop column if exists suggested_access;

revoke all on function public.person_snapshot(public.people) from public, anon, authenticated;
revoke all on function public.claim_existing_account(text, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_existing_account(text, text, text, text) to authenticated;

commit;
