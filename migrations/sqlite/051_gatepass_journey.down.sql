-- Narrows gatepasses.status back to CREATED/CANCELLED. Any document that had reached a
-- journey state is put back to CREATED, which is the only state the old schema can express
-- for a live document - the audit_log rows that recorded each transition are kept, so what
-- actually happened is not lost. (No semicolons in comments: the runner splits on them.)

CREATE TABLE IF NOT EXISTS gatepasses_old (
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
  CHECK (status IN ('CREATED','CANCELLED'))
);

INSERT INTO gatepasses_old (id, gatepass_number, party_id, gatepass_date, status, remarks, total_quantity, created_by, created_at, updated_at, cancelled_at, cancelled_by, cancel_reason, bilty_number, transport_via)
SELECT id, gatepass_number, party_id, gatepass_date, CASE WHEN status = 'CANCELLED' THEN 'CANCELLED' ELSE 'CREATED' END, remarks, total_quantity, created_by, created_at, updated_at, cancelled_at, cancelled_by, cancel_reason, bilty_number, transport_via FROM gatepasses;

DROP TABLE gatepasses;

ALTER TABLE gatepasses_old RENAME TO gatepasses;

CREATE INDEX IF NOT EXISTS idx_gatepasses_party_id ON gatepasses(party_id);

CREATE INDEX IF NOT EXISTS idx_gatepasses_date ON gatepasses(gatepass_date);

CREATE INDEX IF NOT EXISTS idx_gatepasses_status ON gatepasses(status);
