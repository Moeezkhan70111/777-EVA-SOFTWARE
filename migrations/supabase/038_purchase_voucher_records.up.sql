-- A purchase bill reaches the cloud (docs/54).
--
-- A supplier's purchase bill, with its lines, written on the computer holding the ACCOUNTS lease (local migration
-- 115), where cash vouchers and opening balances are. Like 028, 033, 034 and 037, this is a row in
-- leased_record_types and nothing else: push_leased_record, its revision rules, its lease check, its log trigger and
-- its doorbell ring are 013's and 016's, unchanged.
--
--   A purchase bill    ACCOUNTS    the supplier, date, book and reference numbers, total, its lines (material,
--                                  quantity, price), and its deletion when it is deleted
--
-- It moves no stock, cash or production on any computer: only the supplier ledger and balances read it.
--
-- UNTIL THIS IS APPLIED a bill is answered UNKNOWN_RECORD_TYPE, which the client treats as a deployment-order wait
-- (supabaseTransport.ts): it stays queued, nothing else in the outbox is held up, and it goes once this runs.
-- APPLY THIS BEFORE THE RELEASE THAT CARRIES LOCAL 115 REACHES THE ACCOUNTS COMPUTER.
--
-- UNSCOPED, like every leased record: one factory.
--
-- Requires 013 (leased_record_types) and 011 (the domains, ACCOUNTS). A bill names its supplier (PARTY) and each line
-- its material (INVENTORY_ITEM), which already travel. No revoke, so it runs through execute_sql as well as the SQL
-- editor. Safe to run twice. PREPARED, NOT APPLIED to either project.

begin;

insert into public.sync_aggregate_types (aggregate_type, factory_scoped, note) values
  ('PURCHASE_VOUCHER', false, 'A supplier''s purchase bill with its lines: a leased record (038), accounts lease. Read only by the supplier ledger and balances; moves no stock or cash.')
on conflict (aggregate_type) do nothing;

insert into public.leased_record_types (aggregate_type, lease_domain) values
  ('PURCHASE_VOUCHER', 'ACCOUNTS')
on conflict (aggregate_type) do nothing;

commit;
