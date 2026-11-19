-- A customer's historical ledger archive reaches the cloud (docs/50).
--
-- Customer Ledger > Import old ledger stores one customer's statement from the previous accounting software, with its
-- rows, exactly as it was printed (local migration 111). It is written once, under the ACCOUNTS lease, on the computer
-- that writes cash vouchers. Like 028, 029, 030, 032 and 033, this is a row in leased_record_types and nothing else:
-- push_leased_record, its revision rules, its lease check, its log trigger and its doorbell ring are 013's and 016's,
-- unchanged.
--
--   A ledger archive statement    ACCOUNTS    who it is for, which file and import batch, its totals, and its rows
--
-- NOT ACCOUNTING. An archived statement is a record of what the old software printed. No balance, cash book, stock
-- figure or report in the cloud or on any computer is worked out from it.
--
-- UNTIL THIS IS APPLIED a statement is answered UNKNOWN_RECORD_TYPE, which the client treats as a deployment-order
-- wait (supabaseTransport.ts): it stays queued, nothing else in the outbox is held up, and it goes once this runs.
-- APPLY THIS BEFORE THE RELEASE THAT CARRIES LOCAL 111 REACHES THE ACCOUNTS COMPUTER.
--
-- UNSCOPED, like every leased record: one factory.
--
-- Requires 013 (leased_record_types), 011 (the domains, ACCOUNTS). No revoke, so it runs through execute_sql as well
-- as the SQL editor. Safe to run twice. PREPARED, NOT APPLIED to either project.

begin;

insert into public.sync_aggregate_types (aggregate_type, factory_scoped, note) values
  ('LEDGER_ARCHIVE_STATEMENT', false, 'A customer''s historical ledger statement from the previous accounting software, with its rows, kept as printed: a leased record (034), accounts lease. Never accounting.')
on conflict (aggregate_type) do nothing;

insert into public.leased_record_types (aggregate_type, lease_domain) values
  ('LEDGER_ARCHIVE_STATEMENT', 'ACCOUNTS')
on conflict (aggregate_type) do nothing;

commit;
