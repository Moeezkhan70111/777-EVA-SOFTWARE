-- Undoes 026: carton stock movements leave the cloud, and the carton lease goes.
--
-- WHAT IT COSTS. Every carton movement the cloud holds is dropped. Their log rows stay -- the log is
-- append-only -- so every computer that pulled them keeps its figure, but a computer joining later
-- can no longer be brought to it, and the boss's PC stops following the store. Written to fail rather
-- than discard a lease: if a computer holds CARTON_STOCK, release it first.

begin;

do $$
begin
  if exists (select 1 from public.domain_leases where domain = 'CARTON_STOCK' and holder_device_id is not null) then
    raise exception 'CARTON_STOCK is held by a computer. Release the lease before undoing 026.';
  end if;
end;
$$;

drop function if exists public.push_carton_stock_event(bigint, uuid, jsonb);
drop function if exists public.carton_stock_event_problem(jsonb);
drop trigger if exists trg_carton_stock_events_log on public.carton_stock_events;
drop function if exists public.log_carton_stock_event_insert();
drop table if exists public.carton_stock_events;

-- The type stays registered while the log still holds events of it: the log is append-only and its
-- rows name their type. Removed only on a project whose log never carried one.
delete from public.sync_aggregate_types
 where aggregate_type = 'CARTON_STOCK_EVENT'
   and not exists (select 1 from public.sync_event_log where aggregate_type = 'CARTON_STOCK_EVENT');

-- The lease's history is append-only (011) and names the domain, so a lease that was ever granted
-- keeps its rows, unheld. Removed only when it never was.
delete from public.domain_leases
 where domain = 'CARTON_STOCK'
   and not exists (select 1 from public.domain_lease_events where domain = 'CARTON_STOCK');
delete from public.lease_domains
 where domain = 'CARTON_STOCK'
   and not exists (select 1 from public.domain_leases where domain = 'CARTON_STOCK');

commit;
