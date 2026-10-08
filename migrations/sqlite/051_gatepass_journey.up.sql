-- The Gatepass journey: the Gatepass becomes the master operational document, and its status
-- is the authority for where the goods have reached.
--
--   CREATED    the document is cut and its cartons are reserved (shown as "Gatepass Issued")
--   BILLED     a live sale voucher has been made from it - the store may now work on it
--   AT_GATE    every line has been scanned out of the store and stands at the gate
--   DISPATCHED every line has been scanned onto the vehicle for the party
--   DELIVERED  the builty/delivery photo has been recorded against it
--   CANCELLED  unchanged meaning
--
-- CREATED is kept as the first state rather than renamed to GATEPASS_ISSUED: every existing
-- row carries it, every existing query compares against it, and a rename would be a
-- destructive migration that buys only a word. The screens say "Gatepass Issued".
--
-- AT_GATE, deliberately NOT ON_GATE: qr_master.current_status already has ON_GATE and it
-- means the opposite end of the journey - a carton the customer sent back, standing at the
-- gate, not yet re-entered into the store (migration 035). Two different things must not
-- share one word.
--
-- Nothing in this migration moves stock, touches qr_master, production_events, or any
-- billing/ledger table. It only widens what the status column may hold. SQLite cannot alter
-- a CHECK constraint, so gatepasses is rebuilt the same documented way migration 035 rebuilt
-- qr_master: create new, copy, drop old, rename. The migration runner runs the whole file
-- with foreign keys off, so sale_vouchers.gatepass_id and production_events.gatepass_id
-- survive untouched. Every existing row keeps the status it already has - this is additive.
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS gatepasses_new (
  id TEXT PRIMARY KEY,
  gatepass_number INTEGER NOT NULL UNIQUE,
  party_id TEXT NOT NULL,
  gatepass_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED',
  remarks TEXT,
  total_quantity INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cancelled_at TEXT,
  cancelled_by TEXT,
  cancel_reason TEXT,
  bilty_number TEXT,
  transport_via TEXT,
  FOREIGN KEY (party_id) REFERENCES parties(id),
  CHECK (status IN ('CREATED','BILLED','AT_GATE','DISPATCHED','DELIVERED','CANCELLED'))
);

INSERT INTO gatepasses_new (id, gatepass_number, party_id, gatepass_date, status, remarks, total_quantity, created_by, created_at, updated_at, cancelled_at, cancelled_by, cancel_reason, bilty_number, transport_via)
SELECT id, gatepass_number, party_id, gatepass_date, status, remarks, total_quantity, created_by, created_at, updated_at, cancelled_at, cancelled_by, cancel_reason, bilty_number, transport_via FROM gatepasses;

DROP TABLE gatepasses;

ALTER TABLE gatepasses_new RENAME TO gatepasses;

CREATE INDEX IF NOT EXISTS idx_gatepasses_party_id ON gatepasses(party_id);

CREATE INDEX IF NOT EXISTS idx_gatepasses_date ON gatepasses(gatepass_date);

CREATE INDEX IF NOT EXISTS idx_gatepasses_status ON gatepasses(status);

-- A gatepass already BILLED and beyond is read by stage on every operator list, and the
-- pending lists are the busiest screens in the workflow.
CREATE INDEX IF NOT EXISTS idx_gatepasses_status_number ON gatepasses(status, gatepass_number DESC);
