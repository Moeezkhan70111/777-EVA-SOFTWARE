-- A completed production day reaches the cloud (docs/48).
--
-- "Complete today's production" on the Manual Production page writes one row for the business day (local migration
-- 109). Like 028, 029 and 030, this is a row in leased_record_types and nothing else: push_leased_record, its
-- revision rules, its lease check, its log trigger and its doorbell ring are 013's and 016's, unchanged. No stock
-- moves by it: the day's cartons travel as their own entries and movements, which the cloud already accepts.
--
--   A completed production day    CARTON_STOCK    its date, when and by whom it was marked, the day's cartons then
--
-- UNTIL THIS IS APPLIED a completed day is answered UNKNOWN_RECORD_TYPE, which the client treats as a
-- deployment-order wait (supabaseTransport.ts): it stays queued, nothing else in the outbox is held up, and it goes
-- once this runs. Until then the other computers keep showing "Production not added" for that day, and the carton
-- computer shows the waiting item. APPLY THIS BEFORE THE RELEASE THAT CARRIES LOCAL 109 REACHES THE CARTON COMPUTER.
--
-- UNSCOPED, like every leased record: one factory.
--
-- Requires 013 (leased_record_types), 011 (the domains), 026 (CARTON_STOCK). No revoke, so it runs through execute_sql
-- as well as the SQL editor. TEST project first. Safe to run twice. PREPARED, NOT APPLIED to either project.

begin;

insert into public.sync_aggregate_types (aggregate_type, factory_scoped, note) values
  ('PRODUCTION_DAY', false, 'A business day whose production was marked complete: a leased record (032), carton lease.')
on conflict (aggregate_type) do nothing;

insert into public.leased_record_types (aggregate_type, lease_domain) values
  ('PRODUCTION_DAY', 'CARTON_STOCK')
on conflict (aggregate_type) do nothing;

commit;
