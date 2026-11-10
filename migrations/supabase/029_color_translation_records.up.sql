-- The colour list reaches the cloud (docs/45).
--
-- One English colour and what the factory floor calls it in Urdu, kept as master data (local migration 106). Like
-- 028, this is a row in leased_record_types and nothing else: push_leased_record, its revision rules, its lease
-- check, its log trigger and its doorbell ring are 013's and 016's, unchanged.
--
--   A colour translation    MASTER_DATA    the English colour, as entered, and its Urdu name exactly as entered
--
-- UNTIL THIS IS APPLIED a computer's revision of a colour is answered UNKNOWN_RECORD_TYPE, which the client treats as
-- a deployment-order wait (supabaseTransport.ts): the revision stays queued, nothing else in the outbox is held up,
-- and it goes once this runs. So this can follow the release that brings local 106, in its own window.
--
-- UNSCOPED, like every leased record: one factory.
--
-- Requires 013 (leased_record_types), 011 (the domains). No revoke, so it runs through execute_sql as well as the
-- SQL editor. TEST project first. Safe to run twice. PREPARED, NOT APPLIED to either project.

begin;

insert into public.sync_aggregate_types (aggregate_type, factory_scoped, note) values
  ('COLOR_TRANSLATION', false, 'An English colour and its Urdu name: a leased record (029), master data.')
on conflict (aggregate_type) do nothing;

insert into public.leased_record_types (aggregate_type, lease_domain) values
  ('COLOR_TRANSLATION', 'MASTER_DATA')
on conflict (aggregate_type) do nothing;

commit;
