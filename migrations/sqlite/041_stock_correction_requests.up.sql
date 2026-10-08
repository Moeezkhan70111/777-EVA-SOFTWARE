-- Stock corrections need an administrator's approval before they touch stock.
--
-- Raw material stock moves by itself: a Raw Material Input scan adds one packet, a Raw
-- Material Output scan takes one away. A manual correction is therefore always a statement
-- that the physical count disagrees with the system — a claim, not a movement — and until
-- now anyone holding `stock` could apply one silently.
--
-- From here a correction is a REQUEST with a reason. The administrator approves it, and the
-- approval is what applies it, in the same transaction that records the decision: the
-- request and the stock event can never disagree about whether it happened. An
-- administrator's own correction is applied at once — they are the approver — and is
-- recorded here as an already-approved request, so every correction has one audit trail.

CREATE TABLE IF NOT EXISTS stock_correction_requests (
  id TEXT PRIMARY KEY,
  -- SCR-000001. Quoted on the notification and written into the stock event's note, so the
  -- ledger entry points back at the decision that authorised it.
  request_code TEXT NOT NULL UNIQUE,
  item_id TEXT NOT NULL,
  -- Snapshots, so a request stays readable after a material is renamed or retired. The same
  -- rule the raw-material event log follows with its packing and display-name snapshots.
  item_display_name TEXT NOT NULL,
  item_code TEXT NOT NULL,
  -- Signed: positive adds to stock, negative takes away. Held in unit_id.
  quantity REAL NOT NULL,
  unit_id TEXT,
  -- Required. A correction with no stated cause cannot be judged, so the data layer refuses it.
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

CREATE INDEX IF NOT EXISTS idx_stock_correction_requests_item
  ON stock_correction_requests(item_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_correction_requests_status
  ON stock_correction_requests(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_correction_requests_user
  ON stock_correction_requests(requested_by, requested_at DESC);

-- Only one correction may be open against a material at a time. Two people correcting the
-- same count from different physical checks would each be approved against a balance the
-- other had already moved.
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_correction_requests_one_pending
  ON stock_correction_requests(item_id) WHERE status = 'PENDING';
