-- Undoes 103. An adjustment cannot be stored in the old table, so one that exists stops this: the
-- SELECT below fails its CHECK, and the migration rolls back whole rather than dropping a movement.

CREATE TABLE carton_stock_events_old (
  id TEXT PRIMARY KEY,
  product_variant_id TEXT NOT NULL REFERENCES product_variants(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('MANUAL_PRODUCE', 'GATEPASS_ISSUE', 'GATEPASS_CANCEL', 'MANUAL_PRODUCTION_VOID')),
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
  CHECK (balance_delta = CASE WHEN event_type IN ('GATEPASS_ISSUE', 'MANUAL_PRODUCTION_VOID') THEN -quantity ELSE quantity END),
  CHECK (event_type NOT IN ('MANUAL_PRODUCE', 'MANUAL_PRODUCTION_VOID') OR manual_production_entry_id IS NOT NULL),
  CHECK (event_type NOT IN ('GATEPASS_ISSUE', 'GATEPASS_CANCEL') OR (gatepass_id IS NOT NULL AND gatepass_line_id IS NOT NULL))
);

INSERT INTO carton_stock_events_old (
  id, product_variant_id, event_type, quantity, balance_delta, location_type, location_id, created_by, created_at,
  origin_device_id, replicated_at, manual_production_entry_id, gatepass_id, gatepass_line_id
)
SELECT
  id, product_variant_id, event_type, quantity, balance_delta, location_type, location_id, created_by, created_at,
  origin_device_id, replicated_at, manual_production_entry_id, gatepass_id, gatepass_line_id
FROM carton_stock_events;

DROP TABLE carton_stock_events;

ALTER TABLE carton_stock_events_old RENAME TO carton_stock_events;

CREATE INDEX IF NOT EXISTS idx_carton_stock_events_variant ON carton_stock_events(product_variant_id);

CREATE INDEX IF NOT EXISTS idx_carton_stock_events_gatepass ON carton_stock_events(gatepass_id) WHERE gatepass_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_carton_stock_events_entry_once
  ON carton_stock_events(manual_production_entry_id, event_type) WHERE manual_production_entry_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_carton_stock_events_line_once
  ON carton_stock_events(gatepass_line_id, location_id, event_type) WHERE gatepass_line_id IS NOT NULL;
