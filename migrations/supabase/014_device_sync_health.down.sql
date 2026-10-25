-- Removes the per-computer sync health rows and the report.
--
-- WHAT THIS COSTS. Only the latest report of each computer, which the next one rewrites if 014 is
-- applied again. A computer still reporting gets "function does not exist", which it treats as "this
-- project has no health reports" and carries on syncing.
--
-- Paste whole in the SQL editor. Contains drop, which the MCP tools refuse.

begin;

drop function if exists public.report_sync_health(bigint, uuid, jsonb);
drop function if exists public.sync_health_count(jsonb);
drop table if exists public.device_sync_health;

commit;
