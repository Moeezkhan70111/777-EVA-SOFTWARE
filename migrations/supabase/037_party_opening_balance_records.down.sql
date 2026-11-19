-- Undoes 037. Refused by the foreign keys once an opening balance's revision exists: the log and leased_records name
-- the type.

begin;

delete from public.leased_record_types where aggregate_type = 'PARTY_OPENING_BALANCE';
delete from public.sync_aggregate_types where aggregate_type = 'PARTY_OPENING_BALANCE';

commit;
