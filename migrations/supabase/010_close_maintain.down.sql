-- Gives MAINTAIN back to the client roles, and restores the default that grants new tables
-- TRUNCATE, REFERENCES, TRIGGER and MAINTAIN.
--
-- Re-opens exactly what 010 closed. There is no reason to run this except to return a project to
-- Supabase's defaults deliberately. The existing tables' TRUNCATE, REFERENCES and TRIGGER stay
-- revoked, because 007, not 010, revoked those.

begin;

grant maintain on all tables in schema public to anon, authenticated;

alter default privileges for role postgres in schema public
  grant truncate, references, trigger, maintain on tables to anon, authenticated;

commit;
