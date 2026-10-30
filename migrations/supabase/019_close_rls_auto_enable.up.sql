-- 019: anon and authenticated stop holding EXECUTE on public.rls_auto_enable().
--
-- WHAT IT IS. Supabase's own event-trigger function, present on a project before any migration here:
-- owned by postgres, SECURITY DEFINER, search_path pinned to pg_catalog, fired by the event trigger
-- ensure_rls on every CREATE TABLE in public, where it switches row level security on for the new
-- table. It is why every table in this project has RLS from the moment it exists.
--
-- WHY CLIENTS COULD CALL IT. Its access list is empty, which in PostgreSQL means the default:
-- EXECUTE for PUBLIC, inherited by anon and authenticated. The Advisors report it as "anon can
-- execute SECURITY DEFINER function" -- the one function here a signed-in, enrolled device is not
-- required for.
--
-- 007 WAS WRONG ABOUT IT. 007's header says it "returns event_trigger, so it cannot be invoked as an
-- RPC whatever EXECUTE says". Tested on test, 2026-10-31: as anon, `select public.rls_auto_enable()`
-- runs, as postgres, and returns.
--
-- WHY THAT WAS HARMLESS. Its only action is `alter table ... enable row level security` on the tables
-- created by the DDL command currently firing. Called directly there is none, so it does nothing. It
-- cannot switch RLS off, read a row or write one.
--
-- WHY IT IS CLOSED ANYWAY. Nothing but the event trigger needs it, and a client holds nothing it does
-- not need (007, 010).
--
-- THIS DOES NOT STOP THE EVENT TRIGGER. Proved on test, rolled back, 2026-10-31: with EXECUTE revoked
-- from public, anon and authenticated, a role holding no EXECUTE created a table in public and RLS was
-- still switched on. An event trigger does not check the creating role's EXECUTE; the owner keeps it.
--
-- A project without the function (not a Supabase one) is left alone. Re-running is harmless.
-- Paste whole in the SQL editor, TEST project first. Contains revoke, which the MCP tools refuse.

begin;

do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke all on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$$;

commit;

-- PROVED BY verify_applied_state.sql check 35: neither anon nor authenticated may execute it.
