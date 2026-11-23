-- A GATEPASS MAY BE EDITED, AND A CANCELLED ONE DELETED (owner, 23 Nov 2026).
--
-- EDIT keeps the gatepass's id and its number (the printed paper still matches) and replaces its lines. What it
-- was before is kept as a VERSION, a child of the gatepass record, so it travels with it to every computer and the
-- history can always be read. The edit puts back the cartons the old lines issued directly and issues the new
-- lines' afresh, so every new line gets a NEW id: a line may carry one issue and one return per store row
-- (carton_stock_events' unique index, migration 101), and the old lines keep theirs.
--
-- DELETE is only for a cancelled gatepass: it is marked deleted (who, when, why) and every screen leaves it out.
-- Nothing is erased, and its number is never used again.
--
-- What this does, on every computer:
--   1. gatepasses gains revision_no (1 for every gatepass made so far), edited_at / edited_by, and deleted_at /
--      deleted_by / delete_reason. A computer on an older build writes only the columns it has, so it ignores these.
--   2. gatepass_versions: one row per earlier version of an edited gatepass, its lines as JSON.
--   3. gatepass_order_allocation_lines is rebuilt WITHOUT the foreign key on gatepass_line_id. An edit replaces the
--      gatepass's lines and its order allocation in one transaction here, but another computer receives the two
--      records one at a time: with the key, the gatepass could not drop its old lines while the old allocation
--      still named them, and the new allocation could not arrive before the gatepass's new lines -- each would
--      wait for the other for ever. The index stays, and every row and value is kept.
--
-- Foreign keys are off during migrations (the runner), so the rebuild does not cascade.
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE gatepasses ADD COLUMN revision_no INTEGER NOT NULL DEFAULT 1 CHECK (revision_no > 0);
ALTER TABLE gatepasses ADD COLUMN edited_at TEXT;
ALTER TABLE gatepasses ADD COLUMN edited_by TEXT;
ALTER TABLE gatepasses ADD COLUMN deleted_at TEXT;
ALTER TABLE gatepasses ADD COLUMN deleted_by TEXT;
ALTER TABLE gatepasses ADD COLUMN delete_reason TEXT;

CREATE TABLE IF NOT EXISTS gatepass_versions (
  id TEXT PRIMARY KEY,
  gatepass_id TEXT NOT NULL REFERENCES gatepasses(id),
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  party_id TEXT NOT NULL,
  party_name TEXT NOT NULL,
  bilty_number TEXT,
  transport_via TEXT,
  remarks TEXT,
  total_quantity INTEGER NOT NULL CHECK (total_quantity >= 0),
  lines_json TEXT NOT NULL,
  replaced_at TEXT NOT NULL,
  replaced_by TEXT NOT NULL CHECK (length(trim(replaced_by)) > 0),
  edit_reason TEXT NOT NULL CHECK (length(trim(edit_reason)) > 0),
  UNIQUE (gatepass_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_gatepass_versions_gatepass ON gatepass_versions(gatepass_id);
CREATE INDEX IF NOT EXISTS idx_gatepasses_deleted ON gatepasses(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE gatepass_order_allocation_lines_118 (
  id TEXT PRIMARY KEY,
  allocation_id TEXT NOT NULL REFERENCES gatepass_order_allocations(id),
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  gatepass_line_id TEXT NOT NULL,
  order_line_id TEXT NOT NULL REFERENCES customer_order_lines(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  allocated_at TEXT NOT NULL,
  reversed_at TEXT,
  UNIQUE (allocation_id, line_no)
);

INSERT INTO gatepass_order_allocation_lines_118 (id, allocation_id, line_no, gatepass_line_id, order_line_id, quantity, allocated_at, reversed_at)
SELECT id, allocation_id, line_no, gatepass_line_id, order_line_id, quantity, allocated_at, reversed_at FROM gatepass_order_allocation_lines;

DROP TABLE gatepass_order_allocation_lines;
ALTER TABLE gatepass_order_allocation_lines_118 RENAME TO gatepass_order_allocation_lines;

CREATE INDEX IF NOT EXISTS idx_gatepass_order_allocation_lines_order_line ON gatepass_order_allocation_lines(order_line_id, reversed_at);
CREATE INDEX IF NOT EXISTS idx_gatepass_order_allocation_lines_gatepass_line ON gatepass_order_allocation_lines(gatepass_line_id);
