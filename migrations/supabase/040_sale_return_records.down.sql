-- Undoes 040. Refused by the foreign keys once a sale return revision exists: the log and leased_records name the type.

begin;

delete from public.leased_record_types where aggregate_type = 'SALE_RETURN';
delete from public.sync_aggregate_types where aggregate_type = 'SALE_RETURN';

commit;
