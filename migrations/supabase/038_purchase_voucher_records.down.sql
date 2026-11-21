-- Undoes 038. Refused by the foreign keys once a purchase bill's revision exists: the log and leased_records name
-- the type.

begin;

delete from public.leased_record_types where aggregate_type = 'PURCHASE_VOUCHER';
delete from public.sync_aggregate_types where aggregate_type = 'PURCHASE_VOUCHER';

commit;
