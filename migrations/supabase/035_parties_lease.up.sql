-- Parties get their own write lease, held by the store computer (docs/51).
--
-- MASTER_DATA covered parties together with products, article sizes, machines, groups and colours, and it is held by
-- the office computer (PC1). The store computer (PC2) receives suppliers' deliveries and issues to contractors, and
-- could not add the party in front of it. Parties and party groups now travel under a lease of their own, PARTIES,
-- like the raw-material taxonomy moved to the store's lease in 031. Everything else stays under MASTER_DATA.
--
--   PARTY_GROUP, PARTY                                         MASTER_DATA -> PARTIES
--   products, article sizes, machines, work sections, colours  MASTER_DATA, unchanged
--
-- WHAT THIS DOES, rows only:
--   1. lease_domains gains PARTIES, as 026 added CARTON_STOCK.
--   2. domain_leases gains its row, HELD BY NOBODY. Nothing is granted, released or taken over here: until the owner
--      grants PARTIES (docs/51), no computer may write a party, and every computer still reads them.
--   3. Its barrier starts at the last party or party group revision already in the log, so the computer that is
--      granted PARTIES refuses its own party writes until it has pulled every party the office computer wrote under
--      MASTER_DATA (011's catch-up rule, which a new domain would otherwise start at 0).
--   4. leased_record_types moves the two types to PARTIES. push_leased_record reads it on every push, so its revision
--      rules, its lease check, its log trigger and its doorbell are 013's and 016's, unchanged. Stored records keep
--      their rows. The next revision of one is accepted from the PARTIES holder at its epoch (013 compares revisions,
--      never one row's epoch with the next), so a party edited later keeps its history.
--
-- No party, ledger, voucher or log row is touched. MASTER_DATA's holder, epoch and barrier are not touched.
--
-- APPLY ONLY AFTER every computer runs the release that knows PARTIES (docs/51, deployment order), and after the
-- office computer has sent every party change it holds. A party revision still stamped MASTER_DATA is refused
-- NOT_LEASE_HOLDER after this, visibly, in that computer's dead letters. Reading is unaffected everywhere: a release
-- that does not know PARTIES skips it in current_leases() (leases.ts) and applies parties whoever wrote them.
--
-- Requires 011 (lease_domains, domain_leases) and 013 (leased_record_types). No revoke, so it runs through execute_sql
-- as well as the SQL editor. TEST project first. Safe to run twice: a second run changes nothing (the barrier is only
-- set when the row is first made). PREPARED, NOT APPLIED to either project.

begin;

insert into public.lease_domains (domain, note) values
  ('PARTIES', 'Parties and party groups (035, docs/51): written on the store computer, which adds the supplier or contractor in front of it.')
on conflict (domain) do nothing;

insert into public.domain_leases (domain, barrier_seq)
select 'PARTIES', coalesce(max(l.seq), 0)
  from public.sync_event_log l
 where l.aggregate_type in ('PARTY', 'PARTY_GROUP')
on conflict (domain) do nothing;

update public.leased_record_types
   set lease_domain = 'PARTIES'
 where aggregate_type in ('PARTY', 'PARTY_GROUP');

commit;
