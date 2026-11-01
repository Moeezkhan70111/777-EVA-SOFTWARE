-- NOT A MIGRATION. TEST PROJECT ONLY. The first step of resetting cloud accounts on TEST, for a
-- rehearsal of the switch from a clean start (owner, 2026-11-02: the switch is one press and PC2
-- gets one go, so it is rehearsed from scratch first).
--
-- WHY THE LOG TOO. Undoing 024 to 020 drops the account tables but, by design, leaves the account
-- events in sync_event_log (it is append-only). Applied again, the same people start over at
-- revision 1 -- and a computer that pulls the old events first holds revision 30 and ignores every
-- new one as older (applyPersonRevision keeps the higher). It would also write the old people into a
-- computer still on local accounts. So the old PERSON, ACCOUNT_ROLE and PERMISSION_REQUEST events
-- go, before the undo, with the append-only trigger off for this one transaction only.
--
-- Safe on test only because nothing else is in those events: on 2026-11-02 they were the 52 newest
-- rows of test's log (seq 27298-27349), written by the rehearsal, with no foreign key into the log.
-- Refuses on any project without the rehearsal computers, which production never has.
--
-- THEN, in order: 024, 023, 022, 021, 020 down -- then 020, 021, 022, 023, 024 up -- then every
-- check (accounts, permission requests, first admin, suggested access, login bookkeeping).

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

commit;
