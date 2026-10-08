-- Raw Material Input sessions.
--
-- Receiving raw material is a supplier-at-a-time job: the storekeeper picks the party whose
-- delivery is on the floor, opens a session, and scans that delivery's packets. A session is
-- therefore bound to a party, unlike the carton receiving sessions in 024 which are only an
-- operational grouping per device. Binding the party to the session is what lets every scan
-- be checked against it, so a packet from the wrong supplier is caught at the scanner.
--
-- The scans themselves are the raw_material_qr_events rows carrying this session's id.
-- This table holds only the session envelope, so nothing is duplicated.

CREATE TABLE IF NOT EXISTS raw_material_receiving_sessions (
  id TEXT PRIMARY KEY,
  session_number INTEGER NOT NULL,
  party_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  started_by TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  started_at TEXT NOT NULL,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (party_id) REFERENCES parties(id),
  CHECK (status IN ('OPEN','CLOSED'))
);

CREATE INDEX IF NOT EXISTS idx_rm_receiving_sessions_device_status
  ON raw_material_receiving_sessions(device_id, status);
CREATE INDEX IF NOT EXISTS idx_rm_receiving_sessions_started_at
  ON raw_material_receiving_sessions(started_at DESC);
