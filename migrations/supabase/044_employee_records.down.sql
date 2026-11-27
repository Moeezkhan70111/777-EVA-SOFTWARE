-- Undo 044: the cloud forgets EMPLOYEE. Only while no employee is in leased_records or the log: the foreign keys refuse
-- otherwise, and nothing is deleted.

begin;

delete from public.leased_record_types where aggregate_type = 'EMPLOYEE';
delete from public.sync_aggregate_types where aggregate_type = 'EMPLOYEE';

commit;
