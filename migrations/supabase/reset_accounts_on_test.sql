-- NOT A MIGRATION. TEST PROJECT ONLY. Resets cloud accounts on TEST to how 020-024 leave a fresh
-- project, for a rehearsal of the switch from a clean start (owner, 2026-11-02: the switch is one
-- press and PC2 gets one go, so it is rehearsed from scratch first). Run on test 2026-11-02.
--
-- DATA, NOT SCHEMA. Test's account functions are already at 024, so a clean start needs only the
-- account data gone: the result is what applying 020-024 to a fresh project gives. Undoing and
-- re-applying 020-024 would do the same through two thousand lines -- and would still leave the
-- account events below, since the undo keeps the append-only log.
--
-- WHY THE LOG TOO. The account events in sync_event_log must go with the people. Left there, a
-- computer that pulls them holds revision 30 for a person who now restarts at 1, and ignores every
-- new revision as older (applyPersonRevision keeps the higher) -- and writes the old people into a
-- computer still on local accounts. Both append-only triggers are off for this one transaction only.
--
-- Safe on test only because nothing else is in those events: on 2026-11-02 they were the 52 newest
-- rows of test's log (seq 27298-27349), written by the rehearsal, with no foreign key into the log.
-- Refuses on any project without the rehearsal computers, which production never has.
--
-- Paste into an EMPTY query tab and run with NOTHING highlighted: the SQL editor runs only the
-- highlighted text when there is any, and a highlighted comment reports "Success. No rows returned".
-- Afterwards every check passes (accounts, permission requests, first admin, suggested access,
-- login bookkeeping).

begin;

do $$
begin
  if not exists (select 1 from public.device_accounts where device_id in ('dev-gate-holder', 'dev-gate-reader')) then
    raise exception 'REFUSED: this is not the test project (no rehearsal computers enrolled). Nothing was changed.';
  end if;
end;
$$;

alter table public.sync_event_log disable trigger trg_sync_event_log_immutable;
delete from public.sync_event_log where aggregate_type in ('PERSON', 'ACCOUNT_ROLE', 'PERMISSION_REQUEST');
alter table public.sync_event_log enable trigger trg_sync_event_log_immutable;

alter table public.account_events disable trigger trg_account_events_immutable;
delete from public.account_events;
alter table public.account_events enable trigger trg_account_events_immutable;

delete from public.account_permission_requests;
delete from public.person_tokens;
delete from public.first_admin_designation;
delete from public.people;
delete from public.account_roles;

commit;
