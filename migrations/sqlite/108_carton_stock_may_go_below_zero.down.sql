-- Puts back the CHECK (quantity_on_hand >= 0) that 108 lifted. For a hand rollback only: the application has
-- no downgrade path.
--
-- It cannot run while any product is below zero: the copy below would break the check and the whole script is
-- refused, leaving the table as it was. Record the Manual Production that brings those products back to zero
-- or above first.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE stock_projection_by_variant_never_below_zero (
  product_variant_id TEXT PRIMARY KEY,
  quantity_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  quantity_reserved INTEGER NOT NULL DEFAULT 0,
  quantity_damaged INTEGER NOT NULL DEFAULT 0,
  last_event_ts TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (product_variant_id) REFERENCES product_variants(id)
);

INSERT INTO stock_projection_by_variant_never_below_zero (
  product_variant_id, quantity_on_hand, quantity_reserved, quantity_damaged, last_event_ts, updated_at
)
SELECT product_variant_id, quantity_on_hand, quantity_reserved, quantity_damaged, last_event_ts, updated_at
FROM stock_projection_by_variant
ORDER BY rowid;

DROP TABLE stock_projection_by_variant;
ALTER TABLE stock_projection_by_variant_never_below_zero RENAME TO stock_projection_by_variant;
