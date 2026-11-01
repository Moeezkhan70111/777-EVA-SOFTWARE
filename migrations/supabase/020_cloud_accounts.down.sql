-- Undoes 020. TEST ONLY in practice: on a project where people have signed up, this deletes their
-- accounts, and every PC in cloud mode can then sign nobody in until 020 is applied again.
--
-- The log keeps what it already holds -- it is append-only -- so the two aggregate types are removed
-- only while no event of theirs exists. With events present they stay registered, harmlessly.

begin;

revoke all on function public.sign_up(text, text, text) from authenticated;
revoke all on function public.claim_existing_account(text, text, text, text) from authenticated;
revoke all on function public.verify_login(text, text) from authenticated;
revoke all on function public.change_password(text, text, text) from authenticated;
revoke all on function public.admin_set_access(text, text, text, boolean, text, text[], text, integer) from authenticated;
revoke all on function public.admin_reset_password(text, text, text) from authenticated;
revoke all on function public.admin_save_role(text, text, text, text, text, text[]) from authenticated;
revoke all on function public.admin_delete_role(text, text) from authenticated;
revoke all on function public.admin_import_roles(text, jsonb) from authenticated;

drop function if exists public.make_first_admin(text);
drop function if exists public.admin_import_roles(text, jsonb);
drop function if exists public.admin_delete_role(text, text);
drop function if exists public.admin_save_role(text, text, text, text, text, text[]);
drop function if exists public.admin_reset_password(text, text, text);
drop function if exists public.admin_set_access(text, text, text, boolean, text, text[], text, integer);
drop function if exists public.change_password(text, text, text);
drop function if exists public.verify_login(text, text);
drop function if exists public.claim_existing_account(text, text, text, text);
drop function if exists public.sign_up(text, text, text);
drop function if exists public.account_refusal(text);
drop function if exists public.admin_from_token(text);
drop function if exists public.person_from_token(text);
drop function if exists public.issue_person_token(text);
drop function if exists public.account_permissions_ok(text[]);
drop function if exists public.account_email_problem(text);
drop function if exists public.account_password_problem(text);
drop function if exists public.account_caller();

drop trigger if exists trg_account_roles_log on public.account_roles;
drop trigger if exists trg_people_log on public.people;
drop function if exists public.log_account_role_revision();
drop function if exists public.log_person_revision();
drop function if exists public.account_role_snapshot(public.account_roles);
drop function if exists public.person_snapshot(public.people);

drop table if exists public.account_events;
drop function if exists public.refuse_account_event_change();
drop table if exists public.person_tokens;
drop table if exists public.people;
drop table if exists public.account_roles;

delete from public.sync_aggregate_types t
 where t.aggregate_type in ('PERSON', 'ACCOUNT_ROLE')
   and not exists (select 1 from public.sync_event_log l where l.aggregate_type = t.aggregate_type);

commit;
