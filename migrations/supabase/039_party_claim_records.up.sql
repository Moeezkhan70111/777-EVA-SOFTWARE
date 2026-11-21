-- Claims reach the cloud: asked for by the store, posted by Accounts (docs/55).
--
-- Closing a machine program on the store computer used to POST the claim, at an amount the store typed, onto the
-- party's ledger on that computer only. From the release carrying local 116 the store records a claim REQUEST instead
-- (no money), and the accounts computer prices and posts it. Three leased records, rows in leased_record_types and
-- nothing else, like 034, 037 and 038: push_leased_record, its revision rules, its lease check, its log trigger and
-- its doorbell ring are 013's and 016's, unchanged.
--
--   PARTY_CLAIM_REQUEST     RAW_MATERIAL_STORE   pairs, material, party, reason, program code. No money. Written in the
--                                                program's closing transaction, on the store computer.
--   PARTY_CLAIM             ACCOUNTS             a request priced and posted, and later its reversal (a new revision
--                                                of the same record, with who reversed it and why)
--   PARTY_CLAIM_REJECTION   ACCOUNTS             "nothing is claimed for this request", and why
--
-- So the store computer cannot post, reverse or reject a claim: the cloud refuses a PARTY_CLAIM or a rejection from
-- anyone but the ACCOUNTS holder (NOT_LEASE_HOLDER), and the accounts computer cannot write a request.
-- None of them moves stock, cash or production on any computer: only the party's ledger and balance read a claim.
--
-- UNTIL THIS IS APPLIED each waits as UNKNOWN_RECORD_TYPE, which the client treats as a deployment-order wait
-- (supabaseTransport.ts): it stays queued, nothing else in the outbox is held up, and it goes once this runs.
-- APPLY THIS BEFORE THE RELEASE THAT CARRIES LOCAL 116 REACHES THE STORE OR THE ACCOUNTS COMPUTER.
--
-- Claims the store posted itself before that release are NOT sent by this or by the release: they stay on the store
-- computer until a separate, authorised transfer (docs/55, "Historical claims").
--
-- UNSCOPED, like every leased record: one factory.
--
-- Requires 013 (leased_record_types) and 011 (the domains). A request names its party (PARTY) and material
-- (INVENTORY_ITEM), a claim and a rejection name their request. No revoke, so it runs through execute_sql as well as the
-- SQL editor. Safe to run twice. PREPARED, NOT APPLIED to either project.

begin;

insert into public.sync_aggregate_types (aggregate_type, factory_scoped, note) values
  ('PARTY_CLAIM_REQUEST', false, 'A claim request from closing a machine program: a leased record (039), store lease. Pairs, material, party, reason. No money.'),
  ('PARTY_CLAIM', false, 'A claim priced and posted, or reversed, by Accounts: a leased record (039), accounts lease. A deduction on the party ledger. It moves no stock or cash.'),
  ('PARTY_CLAIM_REJECTION', false, 'Accounts'' answer that nothing is claimed for a request, with why: a leased record (039), accounts lease.')
on conflict (aggregate_type) do nothing;

insert into public.leased_record_types (aggregate_type, lease_domain) values
  ('PARTY_CLAIM_REQUEST', 'RAW_MATERIAL_STORE'),
  ('PARTY_CLAIM', 'ACCOUNTS'),
  ('PARTY_CLAIM_REJECTION', 'ACCOUNTS')
on conflict (aggregate_type) do nothing;

commit;
