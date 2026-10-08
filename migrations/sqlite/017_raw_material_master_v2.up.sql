-- Raw Material Master v2 tables are declared in packages/data/src/local-schema.sql (CREATE TABLE IF NOT EXISTS keeps existing installs and fresh installs in sync).
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

CREATE TABLE IF NOT EXISTS inventory_categories (
  id TEXT PRIMARY KEY,
  category_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('ACTIVE','INACTIVE'))
);

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
