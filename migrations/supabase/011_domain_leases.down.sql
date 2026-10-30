-- Removes the write lease: its functions, its three tables, and the record of every grant,
-- release and takeover.
--
-- WHAT THIS COSTS. domain_lease_events is the only record of who held which domain, and when.
-- Dropping it discards that history for good. Export it first if it matters:
--   select * from public.domain_lease_events order by seq;
--
-- Safe only while no push RPC calls lease_holds(). From 2b on, the leased pushes depend on it, and
-- their own rollbacks must run first -- dropping lease_holds under them makes every leased push
-- fail with "function does not exist".
--
-- Paste whole in the SQL editor. Contains drop, which the MCP tools refuse.

begin;

drop function if exists public.grant_domain_lease(text, text, text);
drop function if exists public.release_domain_lease(bigint, uuid, text, bigint);
drop function if exists public.current_leases();
drop function if exists public.lease_holds(text, text, bigint);
drop function if exists public.last_seq_written_by(text);

drop trigger if exists trg_domain_lease_events_immutable on public.domain_lease_events;
drop function if exists public.refuse_lease_log_change();

drop table if exists public.domain_lease_events;
drop table if exists public.domain_leases;
drop table if exists public.lease_domains;

commit;
