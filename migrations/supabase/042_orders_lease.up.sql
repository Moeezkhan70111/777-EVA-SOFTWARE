-- Customer orders get their own write lease, ORDERS, held by the boss's computer, PC3 (owner, 24 Nov 2026; docs/52).
--
-- Until now an order travelled under SALES_DISPATCH, the gatepass's lease (036), so orders could be entered only on
-- PC1, which makes the gatepasses. The owner wants the boss to enter orders on PC3, while PC1 keeps every gatepass and
-- bill. A lease has one holder, so orders move to a lease of their own, as parties did in 035.
--
--   CUSTOMER_ORDER               SALES_DISPATCH -> ORDERS
--   GATEPASS_ORDER_ALLOCATION    SALES_DISPATCH, unchanged: written by the gatepass's own computer (PC1), in the
--                                gatepass's transaction. It writes allocation rows only, never an order, so PC1 and
--                                PC3 never write the same record.
--
-- THE TRADE THE OWNER ACCEPTED: an order entered on PC3 reaches PC1 at the next sync. A gatepass made on PC1 before it
-- arrives does not count against it (no allocation is ever worked out again), and PC3 sees what was dispatched with the
-- same delay. Pending never goes below zero whatever the timing (allocateFifo).
--
-- WHAT THIS DOES, rows only (as 035):
--   1. lease_domains gains ORDERS.
--   2. domain_leases gains its row, HELD BY NOBODY. Grant it to PC3 straight after, in the same sitting.
--   3. Its barrier starts at the last order revision already in the log, so PC3 refuses its own order writes until it
--      has pulled every order PC1 wrote under SALES_DISPATCH (011's catch-up rule).
--   4. leased_record_types moves CUSTOMER_ORDER to ORDERS. push_leased_record reads it on every push.
--
-- No order, allocation, gatepass, bill or log row is touched. SALES_DISPATCH's holder, epoch and barrier are not
-- touched.
--
-- APPLY ONLY AFTER every computer runs the release that knows ORDERS (0.6.4 onward), and after PC1 has sent every order
-- it holds: an order revision still stamped SALES_DISPATCH is refused NOT_LEASE_HOLDER after this, visibly, in that
-- computer's dead letters. A release that does not know ORDERS skips it in current_leases() and still applies orders.
--
-- Requires 011, 013 and 036. No revoke, so it runs through execute_sql as well as the SQL editor. Safe to run twice.

begin;

insert into public.lease_domains (domain, note) values
  ('ORDERS', 'Customer orders (042, docs/52): entered on the boss''s computer (PC3); gatepasses and bills stay on PC1 under SALES_DISPATCH.')
on conflict (domain) do nothing;

insert into public.domain_leases (domain, barrier_seq)
select 'ORDERS', coalesce(max(l.seq), 0)
  from public.sync_event_log l
 where l.aggregate_type = 'CUSTOMER_ORDER'
on conflict (domain) do nothing;

update public.leased_record_types
   set lease_domain = 'ORDERS'
 where aggregate_type in ('CUSTOMER_ORDER');

commit;
