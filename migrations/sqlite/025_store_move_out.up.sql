-- Store Move Out: a carton leaves the store for the gate, ready to be dispatched.
--
--   WAREHOUSE ("In Store")  --STORE_EXIT-->  TO_GATE ("To Gate")
--   location WAREHOUSE                        location GATE
--
-- SQLite cannot alter CHECK constraints, so qr_master and stock_projection_by_location are
-- rebuilt with the new status / location allowed. The rebuild is the documented
-- create-new / copy / drop-old / rename sequence, run with foreign keys off by the
-- migration runner so production_events' reference to qr_master survives untouched.

CREATE TABLE IF NOT EXISTS qr_master_new (
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
  CHECK (current_status IN ('PRODUCED','WAREHOUSE','TO_GATE','DISPATCHED','SOLD','RETURNED','DAMAGED','SCRAPPED')),
  CHECK (current_location_type IN ('FACTORY','WAREHOUSE','GATE','VEHICLE','CUSTOMER','UNKNOWN'))
);

INSERT INTO qr_master_new (qr_id, product_variant_id, current_status, current_location_type, current_location_id, first_event_id, created_at, updated_at, deleted_at, deleted_by, delete_reason)
SELECT qr_id, product_variant_id, current_status, current_location_type, current_location_id, first_event_id, created_at, updated_at, deleted_at, deleted_by, delete_reason FROM qr_master;

DROP TABLE qr_master;

ALTER TABLE qr_master_new RENAME TO qr_master;

CREATE INDEX IF NOT EXISTS idx_qr_master_current_status ON qr_master(current_status);

CREATE TABLE IF NOT EXISTS stock_projection_by_location_new (
  product_variant_id TEXT NOT NULL,
  location_type TEXT NOT NULL,
  location_id TEXT NOT NULL,
  quantity_on_hand INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (product_variant_id, location_type, location_id),
  FOREIGN KEY (product_variant_id) REFERENCES product_variants(id),
  CHECK (location_type IN ('FACTORY','WAREHOUSE','GATE','VEHICLE','CUSTOMER','UNKNOWN'))
);

INSERT INTO stock_projection_by_location_new (product_variant_id, location_type, location_id, quantity_on_hand, updated_at)
SELECT product_variant_id, location_type, location_id, quantity_on_hand, updated_at FROM stock_projection_by_location;

DROP TABLE stock_projection_by_location;

ALTER TABLE stock_projection_by_location_new RENAME TO stock_projection_by_location;

-- One move-out session per open Store Move Out terminal, the mirror of
-- store_receiving_sessions. Operational grouping only: the authoritative record of each
-- carton is its qr_master row and its MOVED / STORE_EXIT event in production_events.
CREATE TABLE IF NOT EXISTS store_move_out_sessions (
  id TEXT PRIMARY KEY,
  session_number INTEGER NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  started_by TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  started_at TEXT NOT NULL,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('OPEN','CLOSED'))
);

CREATE INDEX IF NOT EXISTS idx_store_move_out_sessions_device_status ON store_move_out_sessions(device_id, status);
