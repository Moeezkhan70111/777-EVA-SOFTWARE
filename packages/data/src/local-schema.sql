-- Bootstrap/base schema only. The migrations/sqlite directory is authoritative for the
-- CURRENT schema. In particular, the monetary REAL columns defined below (cost_price,
-- selling_price, balance_limit, discount_per_pair, start_price, end_price, total_amount,
-- unit_price, discount, total_price, receipt_amount, payment_amount) exist here only so that
-- migration 029_money_paisa_columns has something to add *_paisa siblings to and backfill from
-- on a fresh install; migration 030_retire_real_money_columns drops every one of them again in
-- the same boot sequence. A fresh database's real, final shape has INTEGER paisa columns only.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS factories (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Karachi',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT
);

CREATE TABLE IF NOT EXISTS workstations (
  id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL,
  workstation_code TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT,
  FOREIGN KEY (factory_id) REFERENCES factories(id)
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  device_name TEXT NOT NULL,
  factory_id TEXT NOT NULL,
  workstation_id TEXT,
  os_name TEXT,
  app_version TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT,
  last_sync_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (factory_id) REFERENCES factories(id),
  FOREIGN KEY (workstation_id) REFERENCES workstations(id)
);

CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  external_auth_id TEXT,
  display_name TEXT NOT NULL,
  role_code TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT
);

CREATE TABLE IF NOT EXISTS article_sizes (
  id TEXT PRIMARY KEY,
  article TEXT NOT NULL,
  size TEXT NOT NULL,
  description TEXT,
  cost_price REAL,
  selling_price REAL,
  main_group_id TEXT,
  product_group_id TEXT,
  article_series_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT,
  UNIQUE(article, size),
  FOREIGN KEY (main_group_id) REFERENCES main_groups(id),
  FOREIGN KEY (product_group_id) REFERENCES product_groups(id),
  FOREIGN KEY (article_series_id) REFERENCES article_series(id)
);

CREATE INDEX IF NOT EXISTS idx_article_sizes_article ON article_sizes(article);
CREATE INDEX IF NOT EXISTS idx_article_sizes_status ON article_sizes(status);

CREATE TABLE IF NOT EXISTS product_variants (
  id TEXT PRIMARY KEY,
  article TEXT NOT NULL,
  color TEXT NOT NULL,
  size TEXT NOT NULL,
  description TEXT,
  cost_price REAL,
  selling_price REAL,
  main_group_id TEXT,
  product_group_id TEXT,
  article_series_id TEXT,
  article_size_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT,
  UNIQUE(article, color, size),
  FOREIGN KEY (main_group_id) REFERENCES main_groups(id),
  FOREIGN KEY (product_group_id) REFERENCES product_groups(id),
  FOREIGN KEY (article_series_id) REFERENCES article_series(id)
  ,FOREIGN KEY (article_size_id) REFERENCES article_sizes(id)
);

CREATE TABLE IF NOT EXISTS article_series (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_article_series_name ON article_series(name);

CREATE TABLE IF NOT EXISTS qr_master (
  qr_id TEXT PRIMARY KEY,
  product_variant_id TEXT NOT NULL,
  current_status TEXT NOT NULL,
  current_location_type TEXT NOT NULL DEFAULT 'UNKNOWN',
  current_location_id TEXT,
  first_event_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT,
  FOREIGN KEY (product_variant_id) REFERENCES product_variants(id),
  CHECK (current_status IN ('PRODUCED','WAREHOUSE','TO_GATE','DISPATCHED','ON_GATE','SOLD','RETURNED','DAMAGED','SCRAPPED')),
  CHECK (current_location_type IN ('FACTORY','WAREHOUSE','GATE','VEHICLE','CUSTOMER','UNKNOWN'))
);

CREATE TABLE IF NOT EXISTS production_events (
  id TEXT PRIMARY KEY,
  qr_id TEXT NOT NULL,
  product_variant_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_ts_local TEXT NOT NULL,
  event_date TEXT NOT NULL,
  event_hour INTEGER NOT NULL,
  factory_id TEXT NOT NULL,
  workstation_id TEXT NOT NULL,
  operator_id TEXT,
  device_id TEXT NOT NULL,
  article_snapshot TEXT NOT NULL,
  color_snapshot TEXT NOT NULL,
  size_snapshot TEXT NOT NULL,
  serial_snapshot TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'PENDING',
  synced_at TEXT,
  sync_error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  source_app TEXT NOT NULL DEFAULT 'desktop-scanner',
  FOREIGN KEY (qr_id) REFERENCES qr_master(qr_id),
  FOREIGN KEY (product_variant_id) REFERENCES product_variants(id),
  FOREIGN KEY (workstation_id) REFERENCES workstations(id),
  FOREIGN KEY (factory_id) REFERENCES factories(id),
  FOREIGN KEY (operator_id) REFERENCES operators(id),
  CHECK (event_type IN ('PRODUCED','MOVED','PACKED','DISPATCHED','RETURNED','DAMAGED','SOLD','ADJUSTMENT')),
  CHECK (event_hour BETWEEN 0 AND 23),
  CHECK (sync_status IN ('PENDING','SYNCED','FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_production_events_date ON production_events(event_date);
CREATE INDEX IF NOT EXISTS idx_production_events_variant_date ON production_events(product_variant_id, event_date);
CREATE INDEX IF NOT EXISTS idx_production_events_factory_date ON production_events(factory_id, event_date);
CREATE INDEX IF NOT EXISTS idx_production_events_event_type_date ON production_events(event_type, event_date);

CREATE TABLE IF NOT EXISTS stock_projection_by_variant (
  product_variant_id TEXT PRIMARY KEY,
  quantity_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  quantity_reserved INTEGER NOT NULL DEFAULT 0,
  quantity_damaged INTEGER NOT NULL DEFAULT 0,
  last_event_ts TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (product_variant_id) REFERENCES product_variants(id)
);

CREATE TABLE IF NOT EXISTS stock_projection_by_location (
  product_variant_id TEXT NOT NULL,
  location_type TEXT NOT NULL,
  location_id TEXT NOT NULL,
  quantity_on_hand INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (product_variant_id, location_type, location_id),
  FOREIGN KEY (product_variant_id) REFERENCES product_variants(id),
  CHECK (location_type IN ('FACTORY','WAREHOUSE','GATE','VEHICLE','CUSTOMER','UNKNOWN'))
);

CREATE TABLE IF NOT EXISTS report_daily_summary (
  report_date TEXT NOT NULL,
  factory_id TEXT NOT NULL,
  total_production INTEGER NOT NULL DEFAULT 0,
  total_unique_qr INTEGER NOT NULL DEFAULT 0,
  inventory_value_cost REAL NOT NULL DEFAULT 0,
  inventory_value_sales REAL NOT NULL DEFAULT 0,
  generated_at TEXT NOT NULL,
  PRIMARY KEY (report_date, factory_id),
  FOREIGN KEY (factory_id) REFERENCES factories(id)
);

CREATE TABLE IF NOT EXISTS sync_outbox (
  id TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  lock_token TEXT,
  available_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (aggregate_type IN ('QR_MASTER','PRODUCTION_EVENT','DISPATCH_EVENT','RETURN_EVENT','PROJECTION')),
  CHECK (operation IN ('INSERT','UPDATE')),
  CHECK (status IN ('PENDING','IN_FLIGHT','FAILED','DEAD_LETTER','SYNCED'))
);

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'string',
  is_encrypted INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  CHECK (value_type IN ('string','number','boolean','json'))
);

CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'USER',
  authority_level INTEGER NOT NULL DEFAULT 10,
  job_role TEXT NOT NULL DEFAULT '',
  role_notification TEXT,
  access_status TEXT NOT NULL DEFAULT 'PENDING',
  permissions_json TEXT NOT NULL DEFAULT '[]',
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (role IN ('USER','ADMIN')),
  CHECK (access_status IN ('PENDING','APPROVED','REJECTED'))
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  login_date TEXT NOT NULL,
  revoked_at TEXT,
  expires_at TEXT,
  FOREIGN KEY (user_id) REFERENCES app_users(id)
);

CREATE INDEX IF NOT EXISTS idx_app_users_username ON app_users(username);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token);

CREATE TABLE IF NOT EXISTS job_role_options (
  name TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  role_code TEXT PRIMARY KEY,
  role_name TEXT NOT NULL UNIQUE,
  description TEXT,
  login_policy TEXT NOT NULL DEFAULT 'ALWAYS_LOGGED_IN',
  is_system_role INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_code TEXT NOT NULL,
  permission_code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (role_code, permission_code),
  FOREIGN KEY (role_code) REFERENCES roles(role_code)
);

CREATE TABLE IF NOT EXISTS user_role_assignments (
  user_id TEXT PRIMARY KEY,
  role_code TEXT NOT NULL,
  assigned_by TEXT,
  assigned_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES app_users(id),
  FOREIGN KEY (role_code) REFERENCES roles(role_code),
  FOREIGN KEY (assigned_by) REFERENCES app_users(id)
);

CREATE TABLE IF NOT EXISTS user_additional_permissions (
  user_id TEXT NOT NULL,
  permission_code TEXT NOT NULL,
  granted_by TEXT,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, permission_code),
  FOREIGN KEY (user_id) REFERENCES app_users(id),
  FOREIGN KEY (granted_by) REFERENCES app_users(id)
);

CREATE TABLE IF NOT EXISTS user_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  FOREIGN KEY (user_id) REFERENCES app_users(id)
);

CREATE INDEX IF NOT EXISTS idx_user_notifications_user ON user_notifications(user_id, created_at);

CREATE TABLE IF NOT EXISTS permission_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  permission_code TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  requested_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  review_notes TEXT,
  FOREIGN KEY (user_id) REFERENCES app_users(id),
  FOREIGN KEY (reviewed_by) REFERENCES app_users(id)
);
CREATE INDEX IF NOT EXISTS idx_permission_requests_user ON permission_requests(user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_permission_requests_status ON permission_requests(status);

CREATE TABLE IF NOT EXISTS workspace_conversations (
  id TEXT PRIMARY KEY,
  name TEXT,
  type TEXT NOT NULL DEFAULT 'DIRECT',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (created_by) REFERENCES app_users(id)
);

CREATE TABLE IF NOT EXISTS workspace_conversation_members (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (conversation_id) REFERENCES workspace_conversations(id),
  FOREIGN KEY (user_id) REFERENCES app_users(id)
);

CREATE TABLE IF NOT EXISTS workspace_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES workspace_conversations(id),
  FOREIGN KEY (sender_id) REFERENCES app_users(id)
);

CREATE TABLE IF NOT EXISTS workspace_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  assigned_to TEXT NOT NULL,
  assigned_by TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'NORMAL',
  status TEXT NOT NULL DEFAULT 'PENDING',
  due_date TEXT,
  linked_entity_type TEXT,
  linked_entity_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (assigned_to) REFERENCES app_users(id),
  FOREIGN KEY (assigned_by) REFERENCES app_users(id)
);

CREATE TABLE IF NOT EXISTS workspace_requests (
  id TEXT PRIMARY KEY,
  request_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  requested_by TEXT NOT NULL,
  assigned_to TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'NORMAL',
  status TEXT NOT NULL DEFAULT 'PENDING',
  due_date TEXT,
  linked_entity_type TEXT,
  linked_entity_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (requested_by) REFERENCES app_users(id),
  FOREIGN KEY (assigned_to) REFERENCES app_users(id)
);

CREATE TABLE IF NOT EXISTS workspace_activity (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  description TEXT NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (actor_id) REFERENCES app_users(id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_conversation_members(user_id);
CREATE INDEX IF NOT EXISTS idx_workspace_messages_conversation ON workspace_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workspace_tasks_assigned ON workspace_tasks(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_workspace_requests_assigned ON workspace_requests(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_workspace_activity_created ON workspace_activity(created_at);

CREATE TABLE IF NOT EXISTS access_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING',
  requested_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  FOREIGN KEY (user_id) REFERENCES app_users(id),
  FOREIGN KEY (reviewed_by) REFERENCES app_users(id),
  CHECK (status IN ('PENDING','APPROVED','REJECTED'))
);

CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status);

CREATE TABLE IF NOT EXISTS backup_history (
  id TEXT PRIMARY KEY,
  backup_type TEXT NOT NULL,
  backup_path TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  verification_at TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (backup_type IN ('AUTO_DAILY','MANUAL')),
  CHECK (status IN ('CREATED','VERIFIED','FAILED','RESTORED'))
);

CREATE TABLE IF NOT EXISTS system_health_snapshots (
  id TEXT PRIMARY KEY,
  captured_at TEXT NOT NULL,
  sqlite_ok INTEGER NOT NULL,
  supabase_ok INTEGER NOT NULL,
  scanner_connected INTEGER NOT NULL,
  pending_sync_count INTEGER NOT NULL,
  failed_sync_count INTEGER NOT NULL,
  last_successful_sync_at TEXT,
  db_size_bytes INTEGER,
  free_disk_bytes INTEGER,
  backup_status TEXT,
  details_json TEXT
);

CREATE TABLE IF NOT EXISTS metrics_counters (
  metric_key TEXT PRIMARY KEY,
  metric_value INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics_timeseries (
  id TEXT PRIMARY KEY,
  metric_key TEXT NOT NULL,
  metric_value REAL NOT NULL,
  labels_json TEXT,
  captured_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor_user_id TEXT,
  actor_device_id TEXT,
  actor_role_code TEXT,
  occurred_at TEXT NOT NULL,
  payload_json TEXT,
  hash_sha256 TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS main_groups (
  id TEXT PRIMARY KEY,
  group_name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT
);

CREATE TABLE IF NOT EXISTS product_groups (
  id TEXT PRIMARY KEY,
  group_name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT
);

CREATE TABLE IF NOT EXISTS party_groups (
  id TEXT PRIMARY KEY,
  group_name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT
);

CREATE TABLE IF NOT EXISTS parties (
  id TEXT PRIMARY KEY,
  party_code TEXT NOT NULL UNIQUE,
  party_name TEXT NOT NULL UNIQUE,
  party_name_urdu TEXT,
  party_type TEXT NOT NULL DEFAULT 'CUSTOMER',
  contact_person TEXT,
  mobile_number TEXT,
  whatsapp_number TEXT,
  phone_number TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  party_group_id TEXT,
  remarks TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  is_active INTEGER NOT NULL DEFAULT 1,
  balance_limit REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT,
  FOREIGN KEY (party_group_id) REFERENCES party_groups(id),
  CHECK (party_type IN ('CUSTOMER','SUPPLIER','CONTRACTOR','DISTRIBUTOR','DEALER','TRANSPORTER')),
  CHECK (status IN ('ACTIVE','INACTIVE'))
);

CREATE INDEX IF NOT EXISTS idx_parties_party_name ON parties(party_name);
CREATE INDEX IF NOT EXISTS idx_parties_city ON parties(city);
CREATE INDEX IF NOT EXISTS idx_parties_party_group_id ON parties(party_group_id);
CREATE INDEX IF NOT EXISTS idx_parties_status ON parties(status);
CREATE INDEX IF NOT EXISTS idx_party_groups_group_name ON party_groups(group_name);
CREATE INDEX IF NOT EXISTS idx_main_groups_group_name ON main_groups(group_name);
CREATE INDEX IF NOT EXISTS idx_product_groups_group_name ON product_groups(group_name);

CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
CREATE INDEX IF NOT EXISTS idx_qr_master_current_status ON qr_master(current_status);
CREATE INDEX IF NOT EXISTS idx_production_events_qr_id ON production_events(qr_id);
CREATE INDEX IF NOT EXISTS idx_report_daily_summary_factory_date ON report_daily_summary(factory_id, report_date);
CREATE INDEX IF NOT EXISTS idx_audit_log_occurred_at ON audit_log(occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_metrics_timeseries_key_time ON metrics_timeseries(metric_key, captured_at);

-- Raw Material Master v2: category = container, attributes = filterable dimensions, no fixed hierarchy/identity config.
CREATE TABLE IF NOT EXISTS inventory_units (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  symbol TEXT,
  unit_family TEXT NOT NULL DEFAULT 'COUNT',
  decimal_scale INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_unit_conversions (
  id TEXT PRIMARY KEY,
  from_unit_id TEXT NOT NULL,
  to_unit_id TEXT NOT NULL,
  factor REAL NOT NULL CHECK (factor > 0),
  created_at TEXT NOT NULL,
  UNIQUE(from_unit_id, to_unit_id),
  FOREIGN KEY (from_unit_id) REFERENCES inventory_units(id),
  FOREIGN KEY (to_unit_id) REFERENCES inventory_units(id)
);

-- Two levels: a kind of raw material, and the kinds of that. A name only has to be unique
-- among its siblings — see migrations/sqlite/043_inventory_sub_categories.
CREATE TABLE IF NOT EXISTS inventory_categories (
  id TEXT PRIMARY KEY,
  category_code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  /* NULL for a top-level category; the parent's id for a sub-category. */
  parent_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('ACTIVE','INACTIVE'))
);

-- The indexes over parent_id live in migrations/sqlite/043_inventory_sub_categories, NOT
-- here. This file is exec'd in full on every boot, BEFORE migrations run: on a database that
-- already exists the CREATE TABLE above is a no-op, the old table has no parent_id, and an
-- index over it would fail with "no such column" and take the whole boot down.

CREATE TABLE IF NOT EXISTS inventory_category_fields (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL,
  is_required INTEGER NOT NULL DEFAULT 0,
  is_searchable INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(category_id, field_key),
  FOREIGN KEY (category_id) REFERENCES inventory_categories(id),
  CHECK (field_type IN ('TEXT','NUMBER','DROPDOWN','UNIT'))
);

CREATE TABLE IF NOT EXISTS inventory_category_field_options (
  id TEXT PRIMARY KEY,
  field_id TEXT NOT NULL,
  option_value TEXT NOT NULL,
  display_label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(field_id, option_value),
  FOREIGN KEY (field_id) REFERENCES inventory_category_fields(id)
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id TEXT PRIMARY KEY,
  item_code TEXT NOT NULL UNIQUE,
  category_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  signature_hash TEXT NOT NULL,
  default_unit_id TEXT,
  cost_price REAL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(category_id, signature_hash),
  FOREIGN KEY (category_id) REFERENCES inventory_categories(id),
  FOREIGN KEY (default_unit_id) REFERENCES inventory_units(id),
  CHECK (status IN ('ACTIVE','INACTIVE'))
);

CREATE TABLE IF NOT EXISTS inventory_item_values (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  text_value TEXT,
  number_value REAL,
  UNIQUE(item_id, field_id),
  FOREIGN KEY (item_id) REFERENCES inventory_items(id),
  FOREIGN KEY (field_id) REFERENCES inventory_category_fields(id)
);

CREATE TABLE IF NOT EXISTS inventory_stock_events (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_id TEXT NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (item_id) REFERENCES inventory_items(id),
  FOREIGN KEY (unit_id) REFERENCES inventory_units(id),
  CHECK (event_type IN ('RECEIVE','ADJUST','CONSUME','TRANSFER_IN','TRANSFER_OUT','RETURN'))
);

CREATE TABLE IF NOT EXISTS inventory_stock_balances (
  item_id TEXT PRIMARY KEY,
  quantity_on_hand REAL NOT NULL DEFAULT 0,
  unit_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (item_id) REFERENCES inventory_items(id),
  FOREIGN KEY (unit_id) REFERENCES inventory_units(id)
);

CREATE TABLE IF NOT EXISTS inventory_item_audit (
  id TEXT PRIMARY KEY,
  item_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  old_value_json TEXT,
  new_value_json TEXT,
  changed_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (item_id) REFERENCES inventory_items(id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_items_search ON inventory_items(display_name, item_code, status);
CREATE INDEX IF NOT EXISTS idx_inventory_item_values_text ON inventory_item_values(text_value);
CREATE INDEX IF NOT EXISTS idx_inventory_item_values_field ON inventory_item_values(field_id, text_value);
CREATE INDEX IF NOT EXISTS idx_inventory_stock_events_item ON inventory_stock_events(item_id, created_at);

-- A manual stock correction is a claim that the physical count disagrees with the system,
-- so it needs an administrator's approval before it touches stock. The approval is what
-- applies it, inside the same transaction that records the decision. See
-- migrations/sqlite/041_stock_correction_requests.
CREATE TABLE IF NOT EXISTS stock_correction_requests (
  id TEXT PRIMARY KEY,
  request_code TEXT NOT NULL UNIQUE,
  item_id TEXT NOT NULL,
  item_display_name TEXT NOT NULL,
  item_code TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_id TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_notes TEXT,
  FOREIGN KEY (item_id) REFERENCES inventory_items(id),
  FOREIGN KEY (unit_id) REFERENCES inventory_units(id),
  FOREIGN KEY (requested_by) REFERENCES app_users(id),
  FOREIGN KEY (reviewed_by) REFERENCES app_users(id),
  CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  CHECK (quantity <> 0)
);

CREATE INDEX IF NOT EXISTS idx_stock_correction_requests_item ON stock_correction_requests(item_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_correction_requests_status ON stock_correction_requests(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_correction_requests_user ON stock_correction_requests(requested_by, requested_at DESC);
-- Only one correction may be open against a material at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_correction_requests_one_pending ON stock_correction_requests(item_id) WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS party_product_group_discounts (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL,
  product_group_id TEXT NOT NULL,
  discount_per_pair REAL NOT NULL CHECK (discount_per_pair >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(party_id, product_group_id),
  FOREIGN KEY (party_id) REFERENCES parties(id),
  FOREIGN KEY (product_group_id) REFERENCES product_groups(id)
);

CREATE TABLE IF NOT EXISTS party_article_series_discounts (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL,
  article_series_id TEXT NOT NULL,
  discount_per_pair REAL NOT NULL CHECK (discount_per_pair >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(party_id, article_series_id),
  FOREIGN KEY (party_id) REFERENCES parties(id),
  FOREIGN KEY (article_series_id) REFERENCES article_series(id)
);

CREATE TABLE IF NOT EXISTS party_article_discounts (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  size_scope TEXT NOT NULL DEFAULT 'ALL_SIZES' CHECK (size_scope IN ('ALL_SIZES','SEPARATE_SIZES')),
  size TEXT,
  discount_per_pair REAL NOT NULL CHECK (discount_per_pair >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(party_id, article_id, size_scope, size),
  FOREIGN KEY (party_id) REFERENCES parties(id),
  FOREIGN KEY (article_id) REFERENCES product_variants(id)
);

CREATE TABLE IF NOT EXISTS party_price_range_discounts (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL,
  start_price REAL NOT NULL CHECK (start_price >= 0),
  end_price REAL NOT NULL CHECK (end_price >= 0),
  discount_per_pair REAL NOT NULL CHECK (discount_per_pair >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(party_id, start_price, end_price),
  FOREIGN KEY (party_id) REFERENCES parties(id)
);

CREATE INDEX IF NOT EXISTS idx_party_product_group_discounts_party_id ON party_product_group_discounts(party_id);
CREATE INDEX IF NOT EXISTS idx_party_article_series_discounts_party_id ON party_article_series_discounts(party_id);
CREATE INDEX IF NOT EXISTS idx_party_article_discounts_party_article ON party_article_discounts(party_id, article_id);
CREATE INDEX IF NOT EXISTS idx_party_article_discounts_party_size ON party_article_discounts(party_id, size_scope, size);
CREATE INDEX IF NOT EXISTS idx_party_price_range_discounts_party_id ON party_price_range_discounts(party_id, start_price, end_price);

CREATE TABLE IF NOT EXISTS sale_vouchers (
  id TEXT PRIMARY KEY,
  voucher_number TEXT NOT NULL UNIQUE,
  party_id TEXT NOT NULL,
  voucher_date TEXT NOT NULL,
  book_no TEXT NOT NULL,
  sub_party_name TEXT,
  sub_party_name_urdu TEXT,
  sub_party_number TEXT,
  remarks TEXT,
  total_quantity INTEGER NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT,
  FOREIGN KEY (party_id) REFERENCES parties(id),
  CHECK (status IN ('DRAFT','FINALIZED','CANCELLED'))
);

CREATE TABLE IF NOT EXISTS sale_voucher_line_items (
  id TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL,
  product_variant_id TEXT NOT NULL,
  quantity REAL NOT NULL CHECK (quantity > 0),
  unit_price REAL NOT NULL CHECK (unit_price > 0),
  discount REAL NOT NULL DEFAULT 0 CHECK (discount >= 0),
  discount_per_pair REAL NOT NULL DEFAULT 0 CHECK (discount_per_pair >= 0),
  discount_source TEXT NOT NULL DEFAULT 'NONE' CHECK (discount_source IN ('ARTICLE','ARTICLE_SERIES','PRICE_RANGE','PRODUCT_GROUP','NONE')),
  total_price REAL NOT NULL CHECK (total_price > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (voucher_id) REFERENCES sale_vouchers(id) ON DELETE CASCADE,
  FOREIGN KEY (product_variant_id) REFERENCES product_variants(id)
);

CREATE INDEX IF NOT EXISTS idx_sale_vouchers_party_id ON sale_vouchers(party_id);
CREATE INDEX IF NOT EXISTS idx_sale_vouchers_voucher_date ON sale_vouchers(voucher_date);
CREATE INDEX IF NOT EXISTS idx_sale_vouchers_status ON sale_vouchers(status);
CREATE INDEX IF NOT EXISTS idx_sale_voucher_line_items_voucher_id ON sale_voucher_line_items(voucher_id);
CREATE INDEX IF NOT EXISTS idx_sale_voucher_line_items_product_variant_id ON sale_voucher_line_items(product_variant_id);

-- Dispatch sessions: link a sale voucher to a dispatch job so
-- only items matching that voucher's line items are accepted.
CREATE TABLE IF NOT EXISTS dispatch_sessions (
  id TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING',
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (voucher_id) REFERENCES sale_vouchers(id),
  CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','CANCELLED'))
);

CREATE INDEX IF NOT EXISTS idx_dispatch_sessions_voucher_id ON dispatch_sessions(voucher_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_sessions_status ON dispatch_sessions(status);

-- Sale returns: one row is one carton a customer sent back, credited to that customer at the
-- exact rate its own sale voucher line was billed at. Recording a return is a commercial
-- event only -- the carton stands ON_GATE until a normal Store Move In receives it.
-- See migrations/sqlite/035_sale_returns_on_gate.
CREATE TABLE IF NOT EXISTS sale_returns (
  id TEXT PRIMARY KEY,
  return_number TEXT NOT NULL UNIQUE,
  party_id TEXT NOT NULL,
  return_date TEXT NOT NULL,
  qr_id TEXT NOT NULL,
  product_variant_id TEXT NOT NULL,
  dispatch_event_id TEXT NOT NULL,
  dispatch_session_id TEXT,
  sale_voucher_id TEXT,
  sale_voucher_line_item_id TEXT,
  quantity_cartons INTEGER NOT NULL DEFAULT 1 CHECK (quantity_cartons > 0),
  unit_price_paisa INTEGER NOT NULL DEFAULT 0,
  discount_per_pair_paisa INTEGER NOT NULL DEFAULT 0,
  total_amount_paisa INTEGER NOT NULL DEFAULT 0,
  remarks TEXT,
  recorded_by TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT,
  FOREIGN KEY (party_id) REFERENCES parties(id),
  FOREIGN KEY (product_variant_id) REFERENCES product_variants(id),
  FOREIGN KEY (sale_voucher_id) REFERENCES sale_vouchers(id),
  CHECK (status IN ('ACTIVE','CANCELLED'))
);

-- At most one live return per dispatched carton: the database-level idempotency guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sale_returns_dispatch_event_live ON sale_returns(dispatch_event_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sale_returns_party_date ON sale_returns(party_id, return_date);
CREATE INDEX IF NOT EXISTS idx_sale_returns_qr ON sale_returns(qr_id);
CREATE INDEX IF NOT EXISTS idx_sale_returns_voucher ON sale_returns(sale_voucher_id);

-- Cash vouchers for managing payments received from or paid to parties
CREATE TABLE IF NOT EXISTS cash_vouchers (
  id TEXT PRIMARY KEY,
  voucher_number INTEGER NOT NULL UNIQUE,
  party_id TEXT NOT NULL,
  voucher_date TEXT NOT NULL,
  mode_of_transfer TEXT NOT NULL DEFAULT 'Cash',
  description TEXT NOT NULL,
  receipt_amount REAL NOT NULL DEFAULT 0 CHECK (receipt_amount >= 0),
  payment_amount REAL NOT NULL DEFAULT 0 CHECK (payment_amount >= 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT,
  FOREIGN KEY (party_id) REFERENCES parties(id),
  CHECK (status IN ('ACTIVE','CANCELLED')),
  CHECK ((receipt_amount > 0 AND payment_amount = 0) OR (payment_amount > 0 AND receipt_amount = 0))
);

CREATE INDEX IF NOT EXISTS idx_cash_vouchers_party_id ON cash_vouchers(party_id);
CREATE INDEX IF NOT EXISTS idx_cash_vouchers_voucher_date ON cash_vouchers(voucher_date);
CREATE INDEX IF NOT EXISTS idx_cash_vouchers_voucher_number ON cash_vouchers(voucher_number);
CREATE INDEX IF NOT EXISTS idx_cash_vouchers_status ON cash_vouchers(status);

CREATE TABLE IF NOT EXISTS cash_voucher_lines (
  id TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL,
  party_id TEXT NOT NULL,
  description TEXT NOT NULL,
  mode_of_transfer TEXT NOT NULL DEFAULT 'Cash',
  receipt_amount REAL NOT NULL DEFAULT 0 CHECK (receipt_amount >= 0),
  payment_amount REAL NOT NULL DEFAULT 0 CHECK (payment_amount >= 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (voucher_id) REFERENCES cash_vouchers(id) ON DELETE CASCADE,
  FOREIGN KEY (party_id) REFERENCES parties(id),
  CHECK ((receipt_amount > 0 AND payment_amount = 0) OR (payment_amount > 0 AND receipt_amount = 0))
);

CREATE INDEX IF NOT EXISTS idx_cash_voucher_lines_voucher_id ON cash_voucher_lines(voucher_id);

-- Purchase vouchers: supplier bills for raw materials
CREATE TABLE IF NOT EXISTS purchase_vouchers (
  id TEXT PRIMARY KEY,
  voucher_number TEXT NOT NULL UNIQUE,
  party_id TEXT NOT NULL,
  voucher_date TEXT NOT NULL,
  book_no TEXT,
  reference_no TEXT,
  remarks TEXT,
  total_quantity REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'FINALIZED',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT,
  FOREIGN KEY (party_id) REFERENCES parties(id),
  CHECK (status IN ('DRAFT','FINALIZED','CANCELLED'))
);

CREATE TABLE IF NOT EXISTS purchase_voucher_line_items (
  id TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL DEFAULT 0,
  total_price REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (voucher_id) REFERENCES purchase_vouchers(id),
  FOREIGN KEY (item_id) REFERENCES inventory_items(id)
);

CREATE INDEX IF NOT EXISTS idx_purchase_vouchers_party ON purchase_vouchers(party_id);
CREATE INDEX IF NOT EXISTS idx_purchase_voucher_lines_voucher ON purchase_voucher_line_items(voucher_id);
