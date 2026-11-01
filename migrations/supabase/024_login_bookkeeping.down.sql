-- Undoes 024: verify_login and make_first_admin as 020 and 022 left them (extracted, not retyped).

begin;

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

commit;
