-- The manual production-to-cash workflow travels between computers (docs/43).
--
-- A MANUAL PRODUCTION ENTRY STANDS ON ITS OWN. Machine programs do not replicate, and a program has a
-- life on the store computer (Dana, uppers, closing) that a production computer must never overwrite. So
-- an entry keeps what the Contractor Ledger needs on itself: the program's number and reference, the machine's
-- name, both contractors, and the rates that applied when it was saved. Its link to a program here,
-- machine_program_id, becomes optional: an entry received from another computer has no program here.
--
-- THE RATES ARE COPIED WHEN THE ENTRY IS SAVED, so a later price change does not rewrite what a contractor
-- earned. A rate is NULL when there was none to copy. That covers every entry made before this migration,
-- which keep being priced the way they always were: this migration does not invent a rate for them.
--
-- SQLite cannot make a column optional or alter a CHECK, so both tables are rebuilt, with every row kept. Nothing
-- refers to manual_production_entries by foreign key (a movement names it as a reference only).
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE manual_production_entries_new (
  id TEXT PRIMARY KEY,
  entry_number INTEGER NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE,
  machine_program_id TEXT REFERENCES machine_programs(id),
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
  void_reason TEXT,
  program_ref TEXT NOT NULL,
  program_number INTEGER NOT NULL,
  machine_name TEXT NOT NULL,
  contractor_party_id TEXT REFERENCES parties(id),
  packing_contractor_party_id TEXT REFERENCES parties(id),
  machine_rate_paisa INTEGER CHECK (machine_rate_paisa IS NULL OR machine_rate_paisa >= 0),
  packing_rate_paisa INTEGER CHECK (packing_rate_paisa IS NULL OR packing_rate_paisa >= 0),
  printing_rate_paisa INTEGER CHECK (printing_rate_paisa IS NULL OR printing_rate_paisa >= 0),
  rate_source TEXT CHECK (rate_source IS NULL OR rate_source IN ('PROGRAM', 'PRODUCT'))
);

INSERT INTO manual_production_entries_new (
  id, entry_number, request_id, machine_program_id, machine_id, article_size_id, product_variant_id, article, size, color,
  cartons, stock_location_id, entry_ts, created_by, created_at, origin_device_id, voided_at, voided_by, void_reason,
  program_ref, program_number, machine_name, contractor_party_id, packing_contractor_party_id
)
SELECT
  e.id, e.entry_number, e.request_id, e.machine_program_id, e.machine_id, e.article_size_id, e.product_variant_id, e.article, e.size, e.color,
  e.cartons, e.stock_location_id, e.entry_ts, e.created_by, e.created_at, e.origin_device_id, e.voided_at, e.voided_by, e.void_reason,
  e.machine_program_id, mp.program_number, mp.machine_name_snapshot, mp.contractor_party_id, mp.packing_contractor_party_id
FROM manual_production_entries e
JOIN machine_programs mp ON mp.id = e.machine_program_id;

DROP TABLE manual_production_entries;

ALTER TABLE manual_production_entries_new RENAME TO manual_production_entries;

CREATE INDEX IF NOT EXISTS idx_manual_production_entries_ts ON manual_production_entries(entry_ts);

CREATE INDEX IF NOT EXISTS idx_manual_production_entries_program ON manual_production_entries(machine_program_id);

CREATE INDEX IF NOT EXISTS idx_manual_production_entries_contractor ON manual_production_entries(contractor_party_id);

CREATE INDEX IF NOT EXISTS idx_manual_production_entries_packing ON manual_production_entries(packing_contractor_party_id);

-- THE OUTBOX LEARNS THE NEW RECORD TYPES, by the same rebuild as 095 and 101. Without it nothing fails at the
-- write, because enqueueSyncEvent never throws, and the record would simply never travel.

CREATE TABLE sync_outbox_with_documents (
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
    'STOCK_EVENT','CARTON_STOCK_EVENT',
    'MAIN_GROUP','PRODUCT_GROUP','ARTICLE_SERIES','PRODUCT_TYPE','PRODUCT_SUB_GROUP','ARTICLE_SIZE',
    'MANUAL_PRODUCTION_ENTRY','GATEPASS','SALE_VOUCHER','CASH_VOUCHER'
  )),
  CHECK (operation IN ('INSERT','UPDATE')),
  CHECK (status IN ('PENDING','IN_FLIGHT','FAILED','DEAD_LETTER','SYNCED'))
);

INSERT INTO sync_outbox_with_documents (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;
ALTER TABLE sync_outbox_with_documents RENAME TO sync_outbox;
CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
