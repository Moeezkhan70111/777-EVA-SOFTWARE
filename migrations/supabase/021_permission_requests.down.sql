-- Undoes 021. TEST ONLY in practice: every request, pending or decided, is deleted. Screens already
-- granted stay granted -- they live in people.extra_permissions (020), not here.
--
-- The log keeps what it already holds, so the type is removed only while no event of it exists.

begin;

revoke all on function public.account_state() from authenticated;
drop function if exists public.account_state();

revoke all on function public.request_permission(text, text, text) from authenticated;
revoke all on function public.admin_review_permission_request(text, text, text, text) from authenticated;

drop function if exists public.admin_review_permission_request(text, text, text, text);
drop function if exists public.request_permission(text, text, text);

drop trigger if exists trg_account_permission_requests_log on public.account_permission_requests;
drop function if exists public.log_permission_request_revision();
drop function if exists public.permission_request_snapshot(public.account_permission_requests);

drop table if exists public.account_permission_requests;

delete from public.sync_aggregate_types t
 where t.aggregate_type = 'PERMISSION_REQUEST'
   and not exists (select 1 from public.sync_event_log l where l.aggregate_type = t.aggregate_type);

commit;
