-- Reverses 015: stock movements stop reaching the cloud.
--
-- WHAT THIS COSTS. The cloud's copy of every movement goes. The sync_event_log rows the trigger
-- wrote STAY (the log is append-only), so computers that applied them keep them, and STOCK_EVENT
-- stays in sync_aggregate_types because those rows refer to it. A computer still pushing gets
-- "function does not exist", which the drain reads as transient: its queue waits.
--
-- Run before 011's rollback, never after: the push calls lease_holds.
--
-- Paste whole in the SQL editor. Contains drop, which the MCP tools refuse.

begin;

drop function if exists public.push_stock_event(bigint, uuid, jsonb);

drop trigger if exists trg_inventory_stock_events_log on public.inventory_stock_events;
drop function if exists public.log_stock_event_insert();

drop table if exists public.inventory_stock_events;

commit;
