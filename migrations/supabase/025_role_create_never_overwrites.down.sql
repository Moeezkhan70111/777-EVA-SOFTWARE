-- Undoes 025: admin_save_role as 020 left it (extracted, not retyped). This brings the overwrite back.

begin;

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

commit;
