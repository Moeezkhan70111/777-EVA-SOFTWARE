-- Closes MAINTAIN, the PostgreSQL 17 privilege 007 could not have known to close.
--
-- FOUND 2026-10-25 by migrations/supabase/verify_applied_state.sql on the test project, its first
-- run: anon held MAINTAIN on 13 tables and authenticated on 21. docs/36 recorded "anon: no privilege
-- at all" -- verified then by a query that does not show MAINTAIN, which only exists since
-- PostgreSQL 17 (the project runs 17.11).
--
-- WHERE IT COMES FROM. The project's default privileges give every table the postgres role creates
-- anon=Dxtm and authenticated=Dxtm: TRUNCATE, REFERENCES, TRIGGER and MAINTAIN. 007 revoked the
-- first three by name from the tables that existed. MAINTAIN -- VACUUM, ANALYZE, REINDEX, CLUSTER,
-- REFRESH MATERIALIZED VIEW and LOCK TABLE -- was never in its list.
--
-- HOW SERIOUS. Low, stated plainly. A client reaches this database only through PostgREST and the
-- claim-checking RPCs, neither of which can issue any of those commands, and anon and authenticated
-- cannot log in on their own. It is closed for the same reason 007 closed TRUNCATE: the access
-- model says a client holds nothing it does not need, and LOCK TABLE is not something a device needs.
--
-- WHAT THIS DOES.
--   1. Revokes MAINTAIN from anon and authenticated on every table in public.
--   2. Stops new tables inheriting any of the four. ALTER DEFAULT PRIVILEGES for the postgres role
--      -- the role the SQL editor and these migrations create tables as -- so the next table is
--      born without them, rather than each migration having to remember (009 does, with revoke
--      all, but nothing enforced that).
-- SELECT, INSERT, UPDATE and DELETE defaults are NOT changed here: each table's client grants are
-- decided by its own migration, and 004/006 revoke what they do not give.
--
-- Paste whole in the SQL editor, test project first (docs/36 section 6a). Contains revoke, which
-- the MCP tools refuse.

begin;

revoke maintain on all tables in schema public from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke truncate, references, trigger, maintain on tables from anon, authenticated;

commit;

-- PROVED BY: verify_applied_state.sql checks 5 and 7 -- anon holds nothing, and authenticated
-- exactly SELECT on the seven synchronised tables -- which read pg_class.relacl directly and so do
-- see MAINTAIN.
