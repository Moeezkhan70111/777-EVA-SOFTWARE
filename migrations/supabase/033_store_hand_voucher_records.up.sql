-- A store hand voucher reaches the cloud (docs/49).
--
-- Store > Move in > By hand and Store > Move out > By hand write raw material moved without labels as one numbered
-- voucher with its lines (local migration 110): SIV- in from a supplier, SOV- out to a supplier or contractor. It may be
-- edited or deleted on its own day, each change a new revision. Like 028, 029, 030 and 032, this is a row in
-- leased_record_types and nothing else: push_leased_record, its revision rules, its lease check, its log trigger and
-- its doorbell ring are 013's and 016's, unchanged. No stock moves by it: each line's movement, and each reversal,
-- travels as its own STOCK_EVENT, which the cloud already accepts (015).
--
--   A store hand voucher    RAW_MATERIAL_STORE    its direction, number, party, day, note, status, and its lines
--
-- UNTIL THIS IS APPLIED a voucher is answered UNKNOWN_RECORD_TYPE, which the client treats as a deployment-order
-- wait (supabaseTransport.ts): it stays queued, nothing else in the outbox is held up, and it goes once this runs.
-- The stock itself is not held up: its movements travel as before. APPLY THIS BEFORE THE RELEASE THAT CARRIES
-- LOCAL 110 REACHES THE STORE COMPUTER.
--
-- UNSCOPED, like every leased record: one factory.
--
-- Requires 013 (leased_record_types), 011 (the domains, RAW_MATERIAL_STORE). No revoke, so it runs through
-- execute_sql as well as the SQL editor. Safe to run twice. PREPARED, NOT APPLIED to either project.

begin;

insert into public.sync_aggregate_types (aggregate_type, factory_scoped, note) values
  ('STORE_HAND_VOUCHER', false, 'A store hand voucher (Move In SIV- or Move Out SOV-) of raw material moved without labels, with its lines: a leased record (033), store lease.')
on conflict (aggregate_type) do nothing;

insert into public.leased_record_types (aggregate_type, lease_domain) values
  ('STORE_HAND_VOUCHER', 'RAW_MATERIAL_STORE')
on conflict (aggregate_type) do nothing;

commit;
