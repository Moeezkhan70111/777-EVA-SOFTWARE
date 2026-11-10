-- Undoes 029. Refused by the foreign keys once a colour revision exists: the log and leased_records name the type.

begin;

delete from public.leased_record_types where aggregate_type = 'COLOR_TRANSLATION';
delete from public.sync_aggregate_types where aggregate_type = 'COLOR_TRANSLATION';

commit;
