-- Undoes 027. An adjustment already in the cloud stops it: the old check would refuse the row, and the
-- log is append-only, so nothing can pretend it did not happen. Reapply 026's functions after this.

begin;

do $$
begin
  if exists (select 1 from public.carton_stock_events where event_type in ('CARTON_ADJUST_IN', 'CARTON_ADJUST_OUT')) then
    raise exception 'Carton adjustments are in the cloud and every computer has applied them. 027 cannot be undone.';
  end if;
end;
$$;

alter table public.carton_stock_events drop constraint if exists carton_stock_events_adjustment_said_why;

alter table public.carton_stock_events drop constraint if exists carton_stock_events_check;
alter table public.carton_stock_events add constraint carton_stock_events_check
  check (balance_delta = case when event_type in ('GATEPASS_ISSUE', 'MANUAL_PRODUCTION_VOID') then -quantity else quantity end);

alter table public.carton_stock_events drop constraint if exists carton_stock_events_event_type_check;
alter table public.carton_stock_events add constraint carton_stock_events_event_type_check
  check (event_type in ('MANUAL_PRODUCE', 'GATEPASS_ISSUE', 'GATEPASS_CANCEL', 'MANUAL_PRODUCTION_VOID'));

alter table public.carton_stock_events drop column if exists reason;

commit;
