-- Undoes 028. Refused by the foreign keys once a record of one of these types exists: the log and leased_records name them.

begin;

delete from public.leased_record_types where aggregate_type in
  ('MAIN_GROUP', 'PRODUCT_GROUP', 'ARTICLE_SERIES', 'PRODUCT_TYPE', 'PRODUCT_SUB_GROUP', 'ARTICLE_SIZE',
   'MANUAL_PRODUCTION_ENTRY', 'GATEPASS', 'SALE_VOUCHER', 'CASH_VOUCHER');
delete from public.sync_aggregate_types where aggregate_type in
  ('MAIN_GROUP', 'PRODUCT_GROUP', 'ARTICLE_SERIES', 'PRODUCT_TYPE', 'PRODUCT_SUB_GROUP', 'ARTICLE_SIZE',
   'MANUAL_PRODUCTION_ENTRY', 'GATEPASS', 'SALE_VOUCHER', 'CASH_VOUCHER');

commit;
