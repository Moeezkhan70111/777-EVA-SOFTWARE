-- Store Scanning: one receiving session per open Store Scanning terminal, so the operator
-- sees "received this session" and a per-product summary of the cartons they just scanned.
-- The session is an operational grouping only. The authoritative record of each carton is
-- still its qr_master row and its MOVED / STORE_ENTRY event in production_events, which
-- carries the session id in metadata_json. Additive only.

CREATE TABLE IF NOT EXISTS store_receiving_sessions (
  id TEXT PRIMARY KEY,
  session_number INTEGER NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  started_by TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  started_at TEXT NOT NULL,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('OPEN','CLOSED'))
);

CREATE INDEX IF NOT EXISTS idx_store_receiving_sessions_device_status ON store_receiving_sessions(device_id, status);
