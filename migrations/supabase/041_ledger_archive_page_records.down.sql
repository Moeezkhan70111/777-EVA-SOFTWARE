-- Undo 041. Pages already logged stay in the log, and their records in leased_records: removing the type only stops
-- new pages being accepted, which then wait as UNKNOWN_RECORD_TYPE on the accounts computer.

begin;

delete from public.leased_record_types where aggregate_type = 'LEDGER_ARCHIVE_ENTRY_PAGE';
delete from public.sync_aggregate_types where aggregate_type = 'LEDGER_ARCHIVE_ENTRY_PAGE';

commit;
