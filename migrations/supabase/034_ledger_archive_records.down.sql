-- Undoes 034. Refused by the foreign keys once a statement's revision exists: the log and leased_records name the type.

begin;

delete from public.leased_record_types where aggregate_type = 'LEDGER_ARCHIVE_STATEMENT';
delete from public.sync_aggregate_types where aggregate_type = 'LEDGER_ARCHIVE_STATEMENT';

commit;
