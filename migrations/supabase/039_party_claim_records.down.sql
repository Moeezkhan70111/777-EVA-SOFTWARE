-- Undoes 039. Refused by the foreign keys once a claim request, claim or rejection revision exists: the log and
-- leased_records name the type.

begin;

delete from public.leased_record_types where aggregate_type in ('PARTY_CLAIM_REQUEST', 'PARTY_CLAIM', 'PARTY_CLAIM_REJECTION');
delete from public.sync_aggregate_types where aggregate_type in ('PARTY_CLAIM_REQUEST', 'PARTY_CLAIM', 'PARTY_CLAIM_REJECTION');

commit;
