-- Undo 118: no edit history, no deletion marks, and the allocation line's foreign key back.
--
-- REFUSED once any gatepass has been edited or deleted: a 117 build has nowhere to keep its history or its mark, and
-- would show a deleted gatepass again. Before that, nothing 118 added holds anything.

CREATE TABLE undo_118_guard (n INTEGER NOT NULL CHECK (n = 0));
INSERT INTO undo_118_guard (n) SELECT COUNT(*) FROM gatepasses WHERE revision_no > 1 OR deleted_at IS NOT NULL;
INSERT INTO undo_118_guard (n) SELECT COUNT(*) FROM gatepass_versions;
DROP TABLE undo_118_guard;

DROP INDEX IF EXISTS idx_gatepasses_deleted;
DROP TABLE gatepass_versions;

ALTER TABLE gatepasses DROP COLUMN delete_reason;
ALTER TABLE gatepasses DROP COLUMN deleted_by;
ALTER TABLE gatepasses DROP COLUMN deleted_at;
ALTER TABLE gatepasses DROP COLUMN edited_by;
ALTER TABLE gatepasses DROP COLUMN edited_at;
ALTER TABLE gatepasses DROP COLUMN revision_no;

CREATE TABLE gatepass_order_allocation_lines_117 (
  id TEXT PRIMARY KEY,
  allocation_id TEXT NOT NULL REFERENCES gatepass_order_allocations(id),
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  gatepass_line_id TEXT NOT NULL REFERENCES gatepass_lines(id),
  order_line_id TEXT NOT NULL REFERENCES customer_order_lines(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  allocated_at TEXT NOT NULL,
  reversed_at TEXT,
  UNIQUE (allocation_id, line_no)
);

INSERT INTO gatepass_order_allocation_lines_117 (id, allocation_id, line_no, gatepass_line_id, order_line_id, quantity, allocated_at, reversed_at)
SELECT id, allocation_id, line_no, gatepass_line_id, order_line_id, quantity, allocated_at, reversed_at FROM gatepass_order_allocation_lines;

DROP TABLE gatepass_order_allocation_lines;
ALTER TABLE gatepass_order_allocation_lines_117 RENAME TO gatepass_order_allocation_lines;

CREATE INDEX IF NOT EXISTS idx_gatepass_order_allocation_lines_order_line ON gatepass_order_allocation_lines(order_line_id, reversed_at);
CREATE INDEX IF NOT EXISTS idx_gatepass_order_allocation_lines_gatepass_line ON gatepass_order_allocation_lines(gatepass_line_id);
