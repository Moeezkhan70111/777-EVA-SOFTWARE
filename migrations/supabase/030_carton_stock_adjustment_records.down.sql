-- Undoes 030. Refused by the foreign keys once a document revision exists: the log and leased_records name the type.

begin;

delete from public.leased_record_types where aggregate_type = 'CARTON_STOCK_ADJUSTMENT';
delete from public.sync_aggregate_types where aggregate_type = 'CARTON_STOCK_ADJUSTMENT';

commit;
