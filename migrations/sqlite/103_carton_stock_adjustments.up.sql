-- Manual carton adjustments (docs/42 section 11): an administrator corrects the figure, with a reason.
--
-- Two more movement types, CARTON_ADJUST_IN and CARTON_ADJUST_OUT, on the same append-only table as
-- every other movement, so they travel, apply once and reconcile the same way. As ever the type alone
-- decides the sign, and the quantity is always positive.
--
-- reason is new: required on an adjustment, and null on everything else, whose reason is the document
-- it names. It travels with the movement, so every computer can say why the figure moved.
--
-- SQLite cannot alter a CHECK, so the table is rebuilt. Nothing refers to it. The capture trigger goes
-- with the old table and is put back when the database opens (installCaptureTriggers, on every boot).
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE carton_stock_events_new (
  id TEXT PRIMARY KEY,
  product_variant_id TEXT NOT NULL REFERENCES product_variants(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('MANUAL_PRODUCE', 'GATEPASS_ISSUE', 'GATEPASS_CANCEL', 'MANUAL_PRODUCTION_VOID', 'CARTON_ADJUST_IN', 'CARTON_ADJUST_OUT')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  balance_delta INTEGER NOT NULL,
  location_type TEXT NOT NULL CHECK (location_type = 'WAREHOUSE'),
  location_id TEXT NOT NULL CHECK (length(trim(location_id)) > 0),
  created_by TEXT,
  created_at TEXT NOT NULL,
  origin_device_id TEXT,
  replicated_at TEXT,
  manual_production_entry_id TEXT,
  gatepass_id TEXT,
  gatepass_line_id TEXT,
  reason TEXT,
  CHECK (balance_delta = CASE WHEN event_type IN ('GATEPASS_ISSUE', 'MANUAL_PRODUCTION_VOID', 'CARTON_ADJUST_OUT') THEN -quantity ELSE quantity END),
  CHECK (event_type NOT IN ('MANUAL_PRODUCE', 'MANUAL_PRODUCTION_VOID') OR manual_production_entry_id IS NOT NULL),
  CHECK (event_type NOT IN ('GATEPASS_ISSUE', 'GATEPASS_CANCEL') OR (gatepass_id IS NOT NULL AND gatepass_line_id IS NOT NULL)),
  CHECK (event_type NOT IN ('CARTON_ADJUST_IN', 'CARTON_ADJUST_OUT') OR (reason IS NOT NULL AND length(trim(reason)) > 0 AND created_by IS NOT NULL))
);

INSERT INTO carton_stock_events_new (
  id, product_variant_id, event_type, quantity, balance_delta, location_type, location_id, created_by, created_at,
  origin_device_id, replicated_at, manual_production_entry_id, gatepass_id, gatepass_line_id
)
SELECT
  id, product_variant_id, event_type, quantity, balance_delta, location_type, location_id, created_by, created_at,
  origin_device_id, replicated_at, manual_production_entry_id, gatepass_id, gatepass_line_id
FROM carton_stock_events;

DROP TABLE carton_stock_events;

ALTER TABLE carton_stock_events_new RENAME TO carton_stock_events;

CREATE INDEX IF NOT EXISTS idx_carton_stock_events_variant ON carton_stock_events(product_variant_id);

CREATE INDEX IF NOT EXISTS idx_carton_stock_events_gatepass ON carton_stock_events(gatepass_id) WHERE gatepass_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_carton_stock_events_entry_once
  ON carton_stock_events(manual_production_entry_id, event_type) WHERE manual_production_entry_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_carton_stock_events_line_once
  ON carton_stock_events(gatepass_line_id, location_id, event_type) WHERE gatepass_line_id IS NOT NULL;
