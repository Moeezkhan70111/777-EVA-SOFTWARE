-- A customer's or supplier's opening balance reaches the cloud (docs/53).
--
-- Customer Ledger and Supplier Ledger > Opening balance carry a party's verified closing balance from the previous
-- accounting software into the live ERP (local migration 113). One record per party: its position now, and every
-- posting and reversal that led to it. It is written under the ACCOUNTS lease, on the computer that writes cash
-- vouchers. Like 028, 029, 030, 032, 033 and 034, this is a row in leased_record_types and nothing else:
-- push_leased_record, its revision rules, its lease check, its log trigger and its doorbell ring are 013's and
-- 016's, unchanged.
--
--   A party opening balance    ACCOUNTS    the party, its direction, amount, date and source, and its history
--
-- A correction is a reversal and a new posting in ONE revision of the one record, so no computer, and not the cloud,
-- ever holds two opening balances for one party.
--
-- NUMBERED 037: 036 is Pending Orders' customer orders (docs/52). This needs neither 035 nor 036.
--
-- UNTIL THIS IS APPLIED an opening balance is answered UNKNOWN_RECORD_TYPE, which the client treats as a
-- deployment-order wait (supabaseTransport.ts): it stays queued, nothing else in the outbox is held up, and it goes
-- once this runs. APPLY THIS (AND 034) BEFORE THE RELEASE THAT CARRIES LOCAL 113 REACHES THE ACCOUNTS COMPUTER.
--
-- UNSCOPED, like every leased record: one factory.
--
-- Requires 013 (leased_record_types), 011 (the domains, ACCOUNTS) and 034 (an opening balance may name the archived
-- statement it was checked against, which travels as LEDGER_ARCHIVE_STATEMENT). No revoke, so it runs through
-- execute_sql as well as the SQL editor. Safe to run twice. PREPARED, NOT APPLIED to either project.

begin;

insert into public.sync_aggregate_types (aggregate_type, factory_scoped, note) values
  ('PARTY_OPENING_BALANCE', false, 'A customer''s or supplier''s opening balance from the previous accounting software, with every posting and reversal: a leased record (037), accounts lease. Counts only in that party''s balance.')
on conflict (aggregate_type) do nothing;

insert into public.leased_record_types (aggregate_type, lease_domain) values
  ('PARTY_OPENING_BALANCE', 'ACCOUNTS')
on conflict (aggregate_type) do nothing;

commit;
