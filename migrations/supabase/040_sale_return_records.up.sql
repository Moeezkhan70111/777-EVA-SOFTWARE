-- A customer's carton return credit reaches the cloud (docs/55).
--
-- A sale return is one carton a customer sent back, credited at the rate its own bill line was billed at. It is
-- recorded on the computer holding SALES_DISPATCH (the return scan is leased there, leaseChannels.ts), and until now it
-- stayed there: every other computer's customer balance was too high by it. From the release carrying local 116 it
-- travels as SALE_RETURN, a leased record under SALES_DISPATCH, like the bill it credits (028). Its cancellation with
-- its bill is a new revision of the same record. Rows in leased_record_types and nothing else, like 038.
--
-- A STOCK DOCUMENT. Like a bill it is sent only once Carton Cloud is active on that computer, and a return recorded
-- before activation is never sent (stockProtection.ts). The carton itself is received by the store as before: no stock
-- moves on any computer because a return arrives, and only the customer's ledger and balance read it.
--
-- The return scan is on the carton QR hold in this release, so no new return can be recorded until QR resumes. This is
-- applied so that, when it does, every computer counts the same returns.
--
-- UNTIL THIS IS APPLIED a return waits as UNKNOWN_RECORD_TYPE (supabaseTransport.ts): it stays queued, nothing else is
-- held up. APPLY THIS BEFORE THE CARTON QR HOLD IS LIFTED, and before the release carrying local 116 reaches the sales
-- computer.
--
-- UNSCOPED. Requires 013 and 028 (SALE_VOUCHER, which a return names). No revoke. Safe to run twice.
-- PREPARED, NOT APPLIED to either project.

begin;

insert into public.sync_aggregate_types (aggregate_type, factory_scoped, note) values
  ('SALE_RETURN', false, 'A carton a customer sent back, credited at its bill line''s rate: a leased record (040), sales lease. Read only by the customer ledger and balance.')
on conflict (aggregate_type) do nothing;

insert into public.leased_record_types (aggregate_type, lease_domain) values
  ('SALE_RETURN', 'SALES_DISPATCH')
on conflict (aggregate_type) do nothing;

commit;
