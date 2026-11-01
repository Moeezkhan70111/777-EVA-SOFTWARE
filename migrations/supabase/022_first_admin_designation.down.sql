-- Undoes 022: the first admin can again be made only of someone who already exists, and sign_up and
-- claim_existing_account return to 020's bodies exactly (extracted from 020, not retyped).
--
-- A designation not yet used is lost with its table. Re-run 022 and name the admin again.

begin;

revoke all on function public.make_first_admin(text, text) from public, anon, authenticated;
drop function if exists public.make_first_admin(text, text);

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

drop function if exists public.take_first_admin_designation(text, text);
drop table if exists public.first_admin_designation;

revoke all on function public.make_first_admin(text) from public, anon, authenticated;
revoke all on function public.sign_up(text, text, text) from public, anon, authenticated;
revoke all on function public.claim_existing_account(text, text, text, text) from public, anon, authenticated;
grant execute on function public.sign_up(text, text, text) to authenticated;
grant execute on function public.claim_existing_account(text, text, text, text) to authenticated;

commit;
