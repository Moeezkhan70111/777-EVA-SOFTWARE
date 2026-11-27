-- A new colour asked for from Enter Orders reaches the computer that writes Product Master (owner, 27 Nov 2026:
-- "MAKE BOSS PC CAN ALSO ADD NEW COLOR IN ENTER ORDERS", "AUTO ACCEPT IT FROM PC1"). Local 121.
--
-- The boss enters orders on PC3 (ORDERS, 042). Colours are Product Master, written only by PC1 (MASTER_DATA). So PC3
-- writes a request (an article and a colour, as text) and PC1 adds the colour on arrival by itself, through its own
-- "+ New colour" call. The article's sizes then travel back as an ARTICLE_SIZE revision from PC1, as always.
--
--   ARTICLE_COLOR_REQUEST    ORDERS    written once on the orders computer, never changed
--
-- Like 036 to 041, rows in sync_aggregate_types and leased_record_types and nothing else: push_leased_record, its
-- revision rules, its lease check, its log trigger and its doorbell ring are 013's and 016's, unchanged. A request moves
-- no stock, money, ledger or order.
--
-- UNTIL THIS IS APPLIED a request is answered UNKNOWN_RECORD_TYPE, which the client treats as a deployment-order wait
-- (supabaseTransport.ts): it stays queued on PC3, nothing else is held up, and it goes once this runs. APPLY BEFORE OR
-- WITH THE RELEASE THAT CARRIES LOCAL 121.
--
-- UNSCOPED, like every leased record: one factory.
--
-- Requires 013 (leased_record_types) and 042 (the ORDERS domain). No revoke, so it runs through execute_sql as well as
-- the SQL editor. Safe to run twice.

begin;

insert into public.sync_aggregate_types (aggregate_type, factory_scoped, note) values
  ('ARTICLE_COLOR_REQUEST', false, 'A new colour asked for an article from Enter Orders (043): a leased record, orders lease. PC1 adds it to Product Master on arrival. Moves no stock or money.')
on conflict (aggregate_type) do nothing;

insert into public.leased_record_types (aggregate_type, lease_domain) values
  ('ARTICLE_COLOR_REQUEST', 'ORDERS')
on conflict (aggregate_type) do nothing;

commit;
