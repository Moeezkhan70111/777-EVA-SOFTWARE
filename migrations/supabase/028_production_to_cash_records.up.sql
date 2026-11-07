-- The manual production-to-cash workflow reaches the cloud (docs/43).
--
-- 013 said it: "Documents and approvals are leased records too. Adding them is a row in leased_record_types,
-- not a new migration of this shape." These are those rows. push_leased_record, its revision rules, its
-- lease check, its log trigger and its doorbell ring are 013's and 016's, unchanged.
--
--   Product master                  MASTER_DATA     the product, its colours, its prices and contractor rates
--   A Manual Production entry       CARTON_STOCK    written where the carton figure is
--   A gatepass with its lines,      SALES_DISPATCH  one domain: a bill is locked to its gatepass
--   and a bill with its lines
--   A cash voucher with its lines   ACCOUNTS
--
-- PRICES NOW REACH THE CLOUD. 017 kept them out on purpose. They travel now because a bill and a contractor's
-- pay must be the same on every computer. No client reads leased_records, and only claimed devices read the log.
--
-- UNSCOPED, like every leased record: one factory.
--
-- Requires 013 (leased_record_types), 011 (the domains). No revoke, so it runs through execute_sql as well as the
-- SQL editor. TEST project first. Safe to run twice.

begin;

insert into public.sync_aggregate_types (aggregate_type, factory_scoped, note) values
  ('MAIN_GROUP', false, 'A product main group: a leased record (028), master data.'),
  ('PRODUCT_GROUP', false, 'A product group: a leased record (028), master data.'),
  ('ARTICLE_SERIES', false, 'An article series: a leased record (028), master data.'),
  ('PRODUCT_TYPE', false, 'A product type: a leased record (028), master data.'),
  ('PRODUCT_SUB_GROUP', false, 'A product sub-group: a leased record (028), master data.'),
  ('ARTICLE_SIZE', false, 'A product (article + size) with its colours, prices and contractor rates: a leased record (028), master data.'),
  ('MANUAL_PRODUCTION_ENTRY', false, 'A Manual Production entry with the rates it was saved at: a leased record (028), carton lease.'),
  ('GATEPASS', false, 'A gatepass with its lines: a leased record (028), sales and dispatch.'),
  ('SALE_VOUCHER', false, 'A bill with its lines: a leased record (028), sales and dispatch.'),
  ('CASH_VOUCHER', false, 'A cash voucher with its lines: a leased record (028), accounts.')
on conflict (aggregate_type) do nothing;

insert into public.leased_record_types (aggregate_type, lease_domain) values
  ('MAIN_GROUP', 'MASTER_DATA'),
  ('PRODUCT_GROUP', 'MASTER_DATA'),
  ('ARTICLE_SERIES', 'MASTER_DATA'),
  ('PRODUCT_TYPE', 'MASTER_DATA'),
  ('PRODUCT_SUB_GROUP', 'MASTER_DATA'),
  ('ARTICLE_SIZE', 'MASTER_DATA'),
  ('MANUAL_PRODUCTION_ENTRY', 'CARTON_STOCK'),
  ('GATEPASS', 'SALES_DISPATCH'),
  ('SALE_VOUCHER', 'SALES_DISPATCH'),
  ('CASH_VOUCHER', 'ACCOUNTS')
on conflict (aggregate_type) do nothing;

commit;
