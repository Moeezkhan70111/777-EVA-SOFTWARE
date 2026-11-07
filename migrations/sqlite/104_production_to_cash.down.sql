-- Undoes 104. An entry with no program here cannot be stored in the old table, and a queued record of a new type
-- cannot be stored in the old outbox. Either one stops this: the INSERT fails, and the migration rolls back whole.

CREATE TABLE manual_production_entries_old (
  id TEXT PRIMARY KEY,
  entry_number INTEGER NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE,
  machine_program_id TEXT NOT NULL REFERENCES machine_programs(id),
  machine_id TEXT NOT NULL REFERENCES machines(id),
  article_size_id TEXT NOT NULL REFERENCES article_sizes(id),
  product_variant_id TEXT NOT NULL REFERENCES product_variants(id),
  article TEXT NOT NULL,
  size TEXT NOT NULL,
  color TEXT NOT NULL,
  cartons INTEGER NOT NULL CHECK (cartons > 0),
  stock_location_id TEXT NOT NULL,
  entry_ts TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  origin_device_id TEXT,
  voided_at TEXT,
  voided_by TEXT,
  void_reason TEXT
);

INSERT INTO manual_production_entries_old (
  id, entry_number, request_id, machine_program_id, machine_id, article_size_id, product_variant_id, article, size, color,
  cartons, stock_location_id, entry_ts, created_by, created_at, origin_device_id, voided_at, voided_by, void_reason
)
SELECT
  id, entry_number, request_id, machine_program_id, machine_id, article_size_id, product_variant_id, article, size, color,
  cartons, stock_location_id, entry_ts, created_by, created_at, origin_device_id, voided_at, voided_by, void_reason
FROM manual_production_entries;

DROP TABLE manual_production_entries;

ALTER TABLE manual_production_entries_old RENAME TO manual_production_entries;

CREATE INDEX IF NOT EXISTS idx_manual_production_entries_ts ON manual_production_entries(entry_ts);

CREATE INDEX IF NOT EXISTS idx_manual_production_entries_program ON manual_production_entries(machine_program_id);

CREATE TABLE sync_outbox_without_documents (
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
  transient_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  lease_epoch INTEGER,
  CHECK (aggregate_type IN (
    'QR_MASTER','PRODUCT_VARIANT','PRODUCTION_EVENT','PRODUCTION_PRODUCED','DISPATCH_EVENT','RETURN_EVENT','PROJECTION',
    'RAW_MATERIAL_QR_BATCH','RAW_MATERIAL_QR',
    'PARTY_GROUP','PARTY','INVENTORY_UNIT','UNIT_LADDER_PRESET','INVENTORY_CATEGORY','INVENTORY_ITEM','WORK_SECTION','MACHINE',
    'STOCK_EVENT','CARTON_STOCK_EVENT'
  )),
  CHECK (operation IN ('INSERT','UPDATE')),
  CHECK (status IN ('PENDING','IN_FLIGHT','FAILED','DEAD_LETTER','SYNCED'))
);

INSERT INTO sync_outbox_without_documents (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;
ALTER TABLE sync_outbox_without_documents RENAME TO sync_outbox;
CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
