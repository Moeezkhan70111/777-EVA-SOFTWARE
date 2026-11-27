-- Employees and their monthly salaries reach the cloud (owner, 27 Nov 2026: the Salaries card). Local 124.
--
--   EMPLOYEE    ACCOUNTS    one employee: name, work, phone, joining day, monthly salary in paisa, working or left
--
-- Written where the accounts are (PC1, ACCOUNTS), as cash vouchers are. Like 036 to 043, rows in sync_aggregate_types
-- and leased_record_types and nothing else: push_leased_record, its revision rules, its lease check, its log trigger
-- and its doorbell ring are 013's and 016's, unchanged. An employee moves no stock, cash or ledger.
--
-- UNTIL THIS IS APPLIED an employee is answered UNKNOWN_RECORD_TYPE, which the client treats as a deployment-order wait
-- (supabaseTransport.ts): it stays queued on PC1, nothing else is held up, and it goes once this runs.
--
-- UNSCOPED, like every leased record: one factory.
--
-- Requires 013 (leased_record_types) and 011 (the ACCOUNTS domain). No revoke, so it runs through execute_sql as well
-- as the SQL editor. Safe to run twice.

begin;

insert into public.sync_aggregate_types (aggregate_type, factory_scoped, note) values
  ('EMPLOYEE', false, 'One employee and their monthly salary (044, Salaries page): a leased record, accounts lease. Moves no stock or money.')
on conflict (aggregate_type) do nothing;

insert into public.leased_record_types (aggregate_type, lease_domain) values
  ('EMPLOYEE', 'ACCOUNTS')
on conflict (aggregate_type) do nothing;

commit;
