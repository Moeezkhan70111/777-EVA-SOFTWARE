DROP INDEX IF EXISTS idx_store_move_out_sessions_device_status;
DROP TABLE IF EXISTS store_move_out_sessions;

-- Units at the gate go back to being In Store so the original CHECK constraints hold.
UPDATE qr_master SET current_status = 'WAREHOUSE' WHERE current_status = 'TO_GATE';
UPDATE qr_master SET current_location_type = 'WAREHOUSE' WHERE current_location_type = 'GATE';

CREATE TABLE IF NOT EXISTS qr_master_old (
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
  CHECK (current_status IN ('PRODUCED','WAREHOUSE','DISPATCHED','SOLD','RETURNED','DAMAGED','SCRAPPED')),
  CHECK (current_location_type IN ('FACTORY','WAREHOUSE','VEHICLE','CUSTOMER','UNKNOWN'))
);

INSERT INTO qr_master_old (qr_id, product_variant_id, current_status, current_location_type, current_location_id, first_event_id, created_at, updated_at, deleted_at, deleted_by, delete_reason)
SELECT qr_id, product_variant_id, current_status, current_location_type, current_location_id, first_event_id, created_at, updated_at, deleted_at, deleted_by, delete_reason FROM qr_master;

DROP TABLE qr_master;

ALTER TABLE qr_master_old RENAME TO qr_master;

CREATE INDEX IF NOT EXISTS idx_qr_master_current_status ON qr_master(current_status);

-- Fold any gate stock back into the store row for the same variant before rebuilding.
INSERT INTO stock_projection_by_location (product_variant_id, location_type, location_id, quantity_on_hand, updated_at)
SELECT product_variant_id, 'WAREHOUSE', location_id, quantity_on_hand, updated_at FROM stock_projection_by_location WHERE location_type = 'GATE'
ON CONFLICT(product_variant_id, location_type, location_id) DO UPDATE SET quantity_on_hand = quantity_on_hand + excluded.quantity_on_hand, updated_at = excluded.updated_at;

DELETE FROM stock_projection_by_location WHERE location_type = 'GATE';

CREATE TABLE IF NOT EXISTS stock_projection_by_location_old (
  product_variant_id TEXT NOT NULL,
  location_type TEXT NOT NULL,
  location_id TEXT NOT NULL,
  quantity_on_hand INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (product_variant_id, location_type, location_id),
  FOREIGN KEY (product_variant_id) REFERENCES product_variants(id),
  CHECK (location_type IN ('FACTORY','WAREHOUSE','VEHICLE','CUSTOMER','UNKNOWN'))
);

INSERT INTO stock_projection_by_location_old (product_variant_id, location_type, location_id, quantity_on_hand, updated_at)
SELECT product_variant_id, location_type, location_id, quantity_on_hand, updated_at FROM stock_projection_by_location;

DROP TABLE stock_projection_by_location;

ALTER TABLE stock_projection_by_location_old RENAME TO stock_projection_by_location;
