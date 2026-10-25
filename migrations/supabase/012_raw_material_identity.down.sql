-- Removes the raw-material label-run and packet mirrors, their log triggers and their pushes.
--
-- WHAT THIS COSTS. The mirror rows go. The sync_event_log rows their triggers wrote STAY: the log
-- is append-only and this file does not touch it, so computers that already applied them keep
-- them. A computer still sending runs gets "function does not exist" on the next push, which the
-- drain reads as transient -- its queue waits, nothing is lost -- until 012 is applied again.
--
-- Run before 011's rollback, never after: these pushes call lease_holds.
--
-- Paste whole in the SQL editor. Contains drop, which the MCP tools refuse.

begin;

drop function if exists public.push_raw_material_qr(bigint, uuid, jsonb);
drop function if exists public.push_raw_material_qr_batch(bigint, uuid, jsonb);

drop trigger if exists trg_raw_material_qrs_log on public.raw_material_qrs;
drop trigger if exists trg_raw_material_qr_batches_log on public.raw_material_qr_batches;
drop function if exists public.log_raw_material_qr_insert();
drop function if exists public.log_raw_material_qr_batch_insert();

drop table if exists public.raw_material_qrs;
drop table if exists public.raw_material_qr_batches;

commit;
