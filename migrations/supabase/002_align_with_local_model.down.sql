-- Puts supabase/schema.sql's original types back.
--
-- Only safe on an EMPTY project. Once real rows exist the casts below will fail — a factory id of
-- 'factory-777' is not a uuid, and a carton at the gate has a status the old check constraint
-- does not allow. That failure is the correct outcome: this reversal would otherwise have to
-- discard business data to succeed, and a down migration must never do that.
--
-- Run it only to redo the alignment on a project that has never been written to.

begin;

alter table workstations drop constraint if exists workstations_factory_id_fkey;
alter table devices drop constraint if exists devices_factory_id_fkey;
alter table devices drop constraint if exists devices_workstation_id_fkey;
alter table qr_master drop constraint if exists qr_master_product_variant_id_fkey;
alter table production_events drop constraint if exists production_events_qr_id_fkey;
alter table production_events drop constraint if exists production_events_product_variant_id_fkey;
alter table production_events drop constraint if exists production_events_factory_id_fkey;
alter table production_events drop constraint if exists production_events_workstation_id_fkey;
alter table production_events drop constraint if exists production_events_operator_id_fkey;
alter table stock_projection_by_variant drop constraint if exists stock_projection_by_variant_product_variant_id_fkey;
alter table stock_projection_by_location drop constraint if exists stock_projection_by_location_product_variant_id_fkey;
alter table report_daily_summary drop constraint if exists report_daily_summary_factory_id_fkey;

alter table production_events alter column metadata_json type jsonb using metadata_json::jsonb;
alter table production_events alter column created_at type timestamptz using created_at::timestamptz;
alter table production_events alter column created_at set default now();
alter table production_events alter column event_date type date using event_date::date;
alter table production_events alter column event_ts_local type timestamptz using event_ts_local::timestamptz;

alter table qr_master alter column updated_at type timestamptz using updated_at::timestamptz;
alter table qr_master alter column updated_at set default now();
alter table qr_master alter column created_at type timestamptz using created_at::timestamptz;
alter table qr_master alter column created_at set default now();

alter table qr_master drop constraint if exists qr_master_current_location_type_check;
alter table qr_master add constraint qr_master_current_location_type_check
  check (current_location_type in ('FACTORY','WAREHOUSE','VEHICLE','CUSTOMER','UNKNOWN'));

alter table qr_master drop constraint if exists qr_master_current_status_check;
alter table qr_master add constraint qr_master_current_status_check
  check (current_status in ('PRODUCED','WAREHOUSE','DISPATCHED','SOLD','RETURNED','DAMAGED','SCRAPPED'));

alter table report_daily_summary alter column factory_id type uuid using factory_id::uuid;
alter table stock_projection_by_location alter column product_variant_id type uuid using product_variant_id::uuid;
alter table stock_projection_by_variant alter column product_variant_id type uuid using product_variant_id::uuid;

alter table production_events alter column operator_id type uuid using operator_id::uuid;
alter table production_events alter column workstation_id type uuid using workstation_id::uuid;
alter table production_events alter column factory_id type uuid using factory_id::uuid;
alter table production_events alter column product_variant_id type uuid using product_variant_id::uuid;
alter table production_events alter column id type uuid using id::uuid;

alter table qr_master alter column first_event_id type uuid using first_event_id::uuid;
alter table qr_master alter column current_location_id type uuid using current_location_id::uuid;
alter table qr_master alter column product_variant_id type uuid using product_variant_id::uuid;

alter table devices alter column workstation_id type uuid using workstation_id::uuid;
alter table devices alter column factory_id type uuid using factory_id::uuid;

alter table product_variants alter column id type uuid using id::uuid;
alter table operators alter column id type uuid using id::uuid;
alter table workstations alter column factory_id type uuid using factory_id::uuid;
alter table workstations alter column id type uuid using id::uuid;
alter table factories alter column id type uuid using id::uuid;

drop trigger if exists trg_qr_master_updated_at on qr_master;
create trigger trg_qr_master_updated_at
before update on qr_master
for each row execute procedure set_updated_at();

alter table workstations add constraint workstations_factory_id_fkey
  foreign key (factory_id) references factories(id);
alter table devices add constraint devices_factory_id_fkey
  foreign key (factory_id) references factories(id);
alter table devices add constraint devices_workstation_id_fkey
  foreign key (workstation_id) references workstations(id);
alter table qr_master add constraint qr_master_product_variant_id_fkey
  foreign key (product_variant_id) references product_variants(id);
alter table production_events add constraint production_events_qr_id_fkey
  foreign key (qr_id) references qr_master(qr_id);
alter table production_events add constraint production_events_product_variant_id_fkey
  foreign key (product_variant_id) references product_variants(id);
alter table production_events add constraint production_events_factory_id_fkey
  foreign key (factory_id) references factories(id);
alter table production_events add constraint production_events_workstation_id_fkey
  foreign key (workstation_id) references workstations(id);
alter table production_events add constraint production_events_operator_id_fkey
  foreign key (operator_id) references operators(id);
alter table stock_projection_by_variant add constraint stock_projection_by_variant_product_variant_id_fkey
  foreign key (product_variant_id) references product_variants(id);
alter table stock_projection_by_location add constraint stock_projection_by_location_product_variant_id_fkey
  foreign key (product_variant_id) references product_variants(id);
alter table report_daily_summary add constraint report_daily_summary_factory_id_fkey
  foreign key (factory_id) references factories(id);

commit;
