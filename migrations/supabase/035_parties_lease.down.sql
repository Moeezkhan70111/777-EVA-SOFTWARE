-- Undoes 035: parties and party groups go back under MASTER_DATA, and the PARTIES lease is removed.
--
-- Refused while anything names PARTIES: domain_lease_events once it has been granted (a grant is history and is never
-- deleted), so after a grant this is not reversible by rows alone, by design. Before a grant it removes cleanly.
-- Party records and the log are not touched. After it, party revisions are accepted again only from MASTER_DATA's
-- holder, so a computer that wrote parties under PARTIES must stop before this runs.

begin;

update public.leased_record_types
   set lease_domain = 'MASTER_DATA'
 where aggregate_type in ('PARTY', 'PARTY_GROUP');

delete from public.domain_leases where domain = 'PARTIES';
delete from public.lease_domains where domain = 'PARTIES';

commit;
