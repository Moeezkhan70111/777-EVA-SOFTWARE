-- Customer orders, and what each gatepass dispatched against them, reach the cloud (docs/52).
--
-- Enter Orders writes a party's order with its lines (local migration 112). Making a gatepass counts its lines against
-- the party's open orders, oldest first, in the gatepass's own transaction, and cancelling it reverses exactly that.
-- Like 028, 029, 030, 032 and 033, this is rows in leased_record_types and nothing else: push_leased_record, its
-- revision rules, its lease check, its log trigger and its doorbell ring are 013's and 016's, unchanged. Neither record
-- moves stock, money or a ledger.
--
--   A customer order                        SALES_DISPATCH   its number, party, day, note, status, and its lines
--   A gatepass's allocation against orders  SALES_DISPATCH   its gatepass, party, status, and its allocation lines
--
-- Both under SALES_DISPATCH, the gatepass's own lease: orders are written where gatepasses are made, so a gatepass
-- allocates against every order there is. A repeated revision is DUPLICATE, so a retried push or a replayed pull
-- counts nothing twice.
--
-- UNTIL THIS IS APPLIED an order or an allocation is answered UNKNOWN_RECORD_TYPE, which the client treats as a
-- deployment-order wait (supabaseTransport.ts): it stays queued, nothing else in the outbox is held up, and it goes once
-- this runs. Gatepasses, bills and stock are not held up. APPLY THIS BEFORE THE RELEASE THAT CARRIES LOCAL 112 REACHES
-- THE COMPUTER THAT HOLDS SALES_DISPATCH.
--
-- UNSCOPED, like every leased record: one factory.
--
-- Requires 013 (leased_record_types), 011 (the domains, SALES_DISPATCH). No revoke, so it runs through execute_sql as
-- well as the SQL editor. Safe to run twice. PREPARED, NOT APPLIED to either project.

begin;

insert into public.sync_aggregate_types (aggregate_type, factory_scoped, note) values
  ('CUSTOMER_ORDER', false, 'A customer order with its lines (Enter Orders): a leased record (036), sales lease. Moves no stock or money.'),
  ('GATEPASS_ORDER_ALLOCATION', false, 'What one gatepass dispatched against customer orders, with its lines: a leased record (036), sales lease. Moves no stock or money.')
on conflict (aggregate_type) do nothing;

insert into public.leased_record_types (aggregate_type, lease_domain) values
  ('CUSTOMER_ORDER', 'SALES_DISPATCH'),
  ('GATEPASS_ORDER_ALLOCATION', 'SALES_DISPATCH')
on conflict (aggregate_type) do nothing;

commit;
