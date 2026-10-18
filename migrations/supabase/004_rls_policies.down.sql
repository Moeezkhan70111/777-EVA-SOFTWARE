-- Removes the policies and the device enrolment table.
--
-- AFTER THIS, EVERY TABLE IS DENIED AGAIN. Row Level Security stays ON -- it is never turned off
-- to make something work -- so dropping the policies returns the project to the state
-- supabase/schema.sql left it in: locked to anon and authenticated alike, reachable only with a
-- service_role key. That is a safe state to be in, not a broken one, but no computer will sync
-- until policies exist again.

begin;

revoke select on factories, workstations, operators, product_variants, sync_event_log from authenticated;
revoke select, insert on qr_master, production_events from authenticated;

drop policy if exists device_reads_sync_event_log on sync_event_log;
drop policy if exists device_inserts_production_events on production_events;
drop policy if exists device_reads_production_events on production_events;
drop policy if exists device_inserts_qr_master on qr_master;
drop policy if exists device_reads_qr_master on qr_master;
drop policy if exists device_reads_product_variants on product_variants;
drop policy if exists device_reads_operators on operators;
drop policy if exists device_reads_workstations on workstations;
drop policy if exists device_reads_factories on factories;
drop policy if exists device_reads_own_enrolment on device_accounts;

drop function if exists public.current_factory_id();
drop function if exists public.is_enrolled_device();

-- Enrolments are deliberate, owner-made records of which computer is which. Dropping the table
-- discards them, and every computer would have to be enrolled again.
drop table if exists device_accounts;

commit;
