-- An archived statement's rows reach the cloud in pages (docs/50, local migration 117).
--
-- 034 made a statement one leased record holding every row. 013 refuses a record over 256 KB (RECORD_TOO_LARGE),
-- which is about 480 rows, and the import accepts up to 5,000 rows a party: a long ledger imported on the accounts
-- computer was refused and never reached another computer. From the release carrying local 117 a statement travels
-- as its header (LEDGER_ARCHIVE_STATEMENT, unchanged here) and its rows in pages of 50, each page a leased record:
--
--   LEDGER_ARCHIVE_ENTRY_PAGE   ACCOUNTS   up to 50 rows of one statement, by their order in it. Its id is the
--                                          statement's id and its page number. Never accounting.
--
-- Rows in leased_record_types and nothing else, like 034 and 038: push_leased_record, its revision rules, its lease
-- check, its log trigger and its doorbell are 013's and 016's, unchanged, and so is the 256 KB limit.
--
-- UNTIL THIS IS APPLIED a page waits as UNKNOWN_RECORD_TYPE (supabaseTransport.ts): it stays queued, nothing else is
-- held up, and it goes once this runs. APPLY THIS BEFORE THE RELEASE CARRYING LOCAL 117 REACHES THE ACCOUNTS COMPUTER.
--
-- EVERY COMPUTER MUST RUN THAT RELEASE BEFORE THE ACCOUNTS COMPUTER SENDS ANY PAGE. A build without 117 does not know
-- this type, refuses it as permanent, and moves past it: it would never show those rows, even after upgrading.
--
-- UNSCOPED. Requires 013, 011 and 034. No revoke. Safe to run twice. PREPARED, NOT APPLIED to either project.

begin;

insert into public.sync_aggregate_types (aggregate_type, factory_scoped, note) values
  ('LEDGER_ARCHIVE_ENTRY_PAGE', false, 'Up to 50 rows of an archived statement from the previous accounting software: a leased record (041), accounts lease. Never accounting.')
on conflict (aggregate_type) do nothing;

insert into public.leased_record_types (aggregate_type, lease_domain) values
  ('LEDGER_ARCHIVE_ENTRY_PAGE', 'ACCOUNTS')
on conflict (aggregate_type) do nothing;

commit;
