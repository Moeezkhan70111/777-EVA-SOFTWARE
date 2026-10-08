-- Supabase Postgres schema (ERP-ready, production module first)

create table if not exists factories (
  id uuid primary key,
  code text not null unique,
  name text not null,
  timezone text not null default 'Asia/Karachi',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text
);

create table if not exists workstations (
  id uuid primary key,
  factory_id uuid not null references factories(id),
  workstation_code text not null unique,
  device_id text not null unique,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text
);

create table if not exists devices (
  id uuid primary key,
  device_name text not null,
  factory_id uuid not null references factories(id),
  workstation_id uuid references workstations(id),
  os_name text,
  app_version text not null,
  is_active boolean not null default true,
  last_seen_at timestamptz,
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists operators (
  id uuid primary key,
  external_auth_id uuid,
  display_name text not null,
  role_code text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text
);

create table if not exists roles (
  role_code text primary key,
  role_name text not null,
  is_system_role boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists role_permissions (
  role_code text not null references roles(role_code),
  permission_code text not null,
  created_at timestamptz not null default now(),
  primary key (role_code, permission_code)
);

create table if not exists product_variants (
  id uuid primary key,
  article text not null,
  color text not null,
  size text not null,
  description text,
  cost_price numeric(12,2),
  selling_price numeric(12,2),
  status text not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  unique(article, color, size)
);

create table if not exists qr_master (
  qr_id text primary key,
  product_variant_id uuid not null references product_variants(id),
  current_status text not null check (current_status in ('PRODUCED','WAREHOUSE','DISPATCHED','SOLD','RETURNED','DAMAGED','SCRAPPED')),
  current_location_type text not null default 'UNKNOWN' check (current_location_type in ('FACTORY','WAREHOUSE','VEHICLE','CUSTOMER','UNKNOWN')),
  current_location_id uuid,
  first_event_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text
);

create table if not exists production_events (
  id uuid primary key,
  qr_id text not null references qr_master(qr_id),
  product_variant_id uuid not null references product_variants(id),
  event_type text not null check (event_type in ('PRODUCED','MOVED','PACKED','DISPATCHED','RETURNED','DAMAGED','SOLD','ADJUSTMENT')),
  event_ts_local timestamptz not null,
  event_date date not null,
  event_hour smallint not null check (event_hour between 0 and 23),
  factory_id uuid not null references factories(id),
  workstation_id uuid not null references workstations(id),
  operator_id uuid references operators(id),
  device_id text not null,
  article_snapshot text not null,
  color_snapshot text not null,
  size_snapshot text not null,
  serial_snapshot text not null,
  metadata_json jsonb,
  created_at timestamptz not null default now(),
  sync_status text not null default 'PENDING' check (sync_status in ('PENDING','SYNCED','FAILED')),
  synced_at timestamptz,
  sync_error text,
  retry_count int not null default 0,
  source_app text not null default 'desktop-scanner'
);

create index if not exists idx_production_events_date on production_events(event_date);
create index if not exists idx_production_events_variant_date on production_events(product_variant_id, event_date);
create index if not exists idx_production_events_factory_date on production_events(factory_id, event_date);
create index if not exists idx_production_events_event_type_date on production_events(event_type, event_date);

create table if not exists stock_projection_by_variant (
  product_variant_id uuid primary key references product_variants(id),
  quantity_on_hand bigint not null default 0,
  quantity_reserved bigint not null default 0,
  quantity_damaged bigint not null default 0,
  last_event_ts timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists stock_projection_by_location (
  product_variant_id uuid not null references product_variants(id),
  location_type text not null check (location_type in ('FACTORY','WAREHOUSE','VEHICLE','CUSTOMER','UNKNOWN')),
  location_id uuid not null,
  quantity_on_hand bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (product_variant_id, location_type, location_id)
);

create table if not exists report_daily_summary (
  report_date date not null,
  factory_id uuid not null references factories(id),
  total_production bigint not null default 0,
  total_unique_qr bigint not null default 0,
  inventory_value_cost numeric(14,2) not null default 0,
  inventory_value_sales numeric(14,2) not null default 0,
  generated_at timestamptz not null default now(),
  primary key (report_date, factory_id)
);

create table if not exists sync_outbox (
  id uuid primary key,
  aggregate_type text not null check (aggregate_type in ('QR_MASTER','PRODUCTION_EVENT','PROJECTION')),
  aggregate_id text not null,
  operation text not null check (operation in ('INSERT','UPDATE')),
  dedupe_key text not null unique,
  payload_json jsonb not null,
  status text not null default 'PENDING' check (status in ('PENDING','IN_FLIGHT','FAILED','DEAD_LETTER','SYNCED')),
  lock_token uuid,
  available_at timestamptz not null default now(),
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app_settings (
  setting_key text primary key,
  setting_value text not null,
  value_type text not null default 'string' check (value_type in ('string','number','boolean','json')),
  is_encrypted boolean not null default false,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table if not exists backup_history (
  id uuid primary key,
  backup_type text not null check (backup_type in ('AUTO_DAILY','MANUAL')),
  backup_path text not null,
  checksum_sha256 text not null,
  size_bytes bigint not null,
  verified boolean not null default false,
  verification_at timestamptz,
  status text not null check (status in ('CREATED','VERIFIED','FAILED','RESTORED')),
  created_at timestamptz not null default now()
);

create table if not exists system_health_snapshots (
  id uuid primary key,
  captured_at timestamptz not null default now(),
  sqlite_ok boolean not null,
  supabase_ok boolean not null,
  scanner_connected boolean not null,
  pending_sync_count int not null,
  failed_sync_count int not null,
  last_successful_sync_at timestamptz,
  db_size_bytes bigint,
  free_disk_bytes bigint,
  backup_status text,
  details_json jsonb
);

create table if not exists metrics_counters (
  metric_key text primary key,
  metric_value bigint not null,
  updated_at timestamptz not null default now()
);

create table if not exists metrics_timeseries (
  id uuid primary key,
  metric_key text not null,
  metric_value numeric(18,4) not null,
  labels_json jsonb,
  captured_at timestamptz not null default now()
);

create table if not exists audit_log (
  id uuid primary key,
  event_type text not null,
  event_version int not null,
  entity_type text not null,
  entity_id text not null,
  actor_user_id uuid,
  actor_device_id uuid,
  actor_role_code text,
  occurred_at timestamptz not null,
  payload_json jsonb,
  hash_sha256 text,
  created_at timestamptz not null default now()
);

create index if not exists idx_sync_outbox_status_available_at on sync_outbox(status, available_at);
create index if not exists idx_qr_master_current_status on qr_master(current_status);
create index if not exists idx_production_events_qr_id on production_events(qr_id);
create index if not exists idx_report_daily_summary_factory_date on report_daily_summary(factory_id, report_date);
create index if not exists idx_audit_log_occurred_at on audit_log(occurred_at);
create index if not exists idx_audit_log_entity on audit_log(entity_type, entity_id);
create index if not exists idx_metrics_timeseries_key_time on metrics_timeseries(metric_key, captured_at);

-- Optional trigger to maintain updated_at
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_product_variants_updated_at on product_variants;
create trigger trg_product_variants_updated_at
before update on product_variants
for each row execute procedure set_updated_at();

drop trigger if exists trg_qr_master_updated_at on qr_master;
create trigger trg_qr_master_updated_at
before update on qr_master
for each row execute procedure set_updated_at();

drop trigger if exists trg_factories_updated_at on factories;
create trigger trg_factories_updated_at
before update on factories
for each row execute procedure set_updated_at();

drop trigger if exists trg_workstations_updated_at on workstations;
create trigger trg_workstations_updated_at
before update on workstations
for each row execute procedure set_updated_at();

drop trigger if exists trg_devices_updated_at on devices;
create trigger trg_devices_updated_at
before update on devices
for each row execute procedure set_updated_at();

drop trigger if exists trg_operators_updated_at on operators;
create trigger trg_operators_updated_at
before update on operators
for each row execute procedure set_updated_at();

drop trigger if exists trg_roles_updated_at on roles;
create trigger trg_roles_updated_at
before update on roles
for each row execute procedure set_updated_at();

-- RLS baseline (adjust per auth model)
alter table factories enable row level security;
alter table workstations enable row level security;
alter table operators enable row level security;
alter table roles enable row level security;
alter table role_permissions enable row level security;
alter table product_variants enable row level security;
alter table qr_master enable row level security;
alter table production_events enable row level security;
alter table stock_projection_by_variant enable row level security;
alter table stock_projection_by_location enable row level security;
alter table report_daily_summary enable row level security;
alter table sync_outbox enable row level security;
alter table devices enable row level security;
alter table app_settings enable row level security;
alter table backup_history enable row level security;
alter table system_health_snapshots enable row level security;
alter table metrics_counters enable row level security;
alter table metrics_timeseries enable row level security;
alter table audit_log enable row level security;

-- Example policy placeholders (must be tailored to your auth claims)
-- create policy "read own factory events" on production_events
-- for select using (factory_id::text = auth.jwt()->>'factory_id');
