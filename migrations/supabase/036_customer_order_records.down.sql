-- Undoes 036. Refused by the foreign keys once an order's or an allocation's revision exists: the log and leased_records
-- name the type.

begin;

delete from public.leased_record_types where aggregate_type in ('CUSTOMER_ORDER', 'GATEPASS_ORDER_ALLOCATION');
delete from public.sync_aggregate_types where aggregate_type in ('CUSTOMER_ORDER', 'GATEPASS_ORDER_ALLOCATION');

commit;
