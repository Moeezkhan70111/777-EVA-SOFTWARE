-- A gatepass may take more cartons than the store holds (owner, 12 Nov 2026).
--
-- The gatepass goes out first and Manual Production records the cartons later. Until then the carton figure
-- shows the shortfall as a minus, never clamped. Only a gatepass may do this: the application refuses every
-- other movement that would take the figure below zero (@erp/domain cartonMovementMayGoBelowZero).
--
-- stock_projection_by_variant carried its own CHECK (quantity_on_hand >= 0), which would refuse that minus,
-- so it is rebuilt without the check. Every row is copied as it is, nothing else about the table changes,
-- and nothing depends on it (no index, trigger or view names it). stock_projection_by_location never had
-- the check. The movements (carton_stock_events) are untouched: the figure is still their sum.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE stock_projection_by_variant_may_go_below_zero (
  product_variant_id TEXT PRIMARY KEY,
  quantity_on_hand INTEGER NOT NULL DEFAULT 0,
  quantity_reserved INTEGER NOT NULL DEFAULT 0,
  quantity_damaged INTEGER NOT NULL DEFAULT 0,
  last_event_ts TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (product_variant_id) REFERENCES product_variants(id)
);

INSERT INTO stock_projection_by_variant_may_go_below_zero (
  product_variant_id, quantity_on_hand, quantity_reserved, quantity_damaged, last_event_ts, updated_at
)
SELECT product_variant_id, quantity_on_hand, quantity_reserved, quantity_damaged, last_event_ts, updated_at
FROM stock_projection_by_variant
ORDER BY rowid;

DROP TABLE stock_projection_by_variant;
ALTER TABLE stock_projection_by_variant_may_go_below_zero RENAME TO stock_projection_by_variant;
