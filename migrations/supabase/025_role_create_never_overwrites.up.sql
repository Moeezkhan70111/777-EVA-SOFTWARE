-- 025: a new role never overwrites an existing one (2026-11-03, docs/41).
--
-- admin_save_role took a null code to mean "make a new role" and coded it from the name -- then
-- wrote it with INSERT ... ON CONFLICT (role_code) DO UPDATE. A role keeps its code when it is
-- renamed, so this sequence overwrote a live role:
--   1. billing-manager, "Billing Manager", is renamed "Billing Desk" (same code);
--   2. an admin creates a role named "Billing Manager", with no code;
--   3. the name is free, the generated code is billing-manager, and the upsert replaced Billing
--      Desk's name, description, policy and screens -- for everyone holding it.
--
-- Now a null code is a CREATE only. The conflict update runs only for an explicit code (editing a
-- role, unchanged) or a deleted role's code (bringing it back, unchanged). A live role holding the
-- generated code is refused as ROLE_CODE_TAKEN, decided by the insert itself, so two admins making
-- the same name at once cannot overwrite each other either.
--
-- Same signature, so 020's grants stand. 020's body otherwise as it was (generated from it, not
-- retyped). Re-running is harmless. 020 itself is not edited.

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

  -- Its name is free; its CODE may not be. A role keeps its code when renamed, so the code a new
  -- name makes can still belong to a live role under another name. That is refused below.
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
   where p_role_code is not null or public.account_roles.deleted
  returning * into saved;

  -- No row: a new role whose code a live role already has. Nothing was written, logged or audited.
  if saved.role_code is null then return public.account_refusal('ROLE_CODE_TAKEN'); end if;

  insert into public.account_events (action, actor_person_id, device_id, subject, detail)
  values ('SAVED_ROLE', admin.id, device.device_id, saved.role_code, public.account_role_snapshot(saved));

  return jsonb_build_object('ok', true, 'role', public.account_role_snapshot(saved));
end;
$$;

commit;
