-- Undoes 032. Refused by the foreign keys once a completed day's revision exists: the log and leased_records name the type.

begin;

delete from public.leased_record_types where aggregate_type = 'PRODUCTION_DAY';
delete from public.sync_aggregate_types where aggregate_type = 'PRODUCTION_DAY';

commit;
