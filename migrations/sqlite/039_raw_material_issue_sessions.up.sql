-- Raw Material Output sessions.
--
-- Issuing is the mirror of receiving, with one difference: there is nothing for the
-- operator to choose. A packet goes to the section configured on its material — rubber
-- uppers to packing, ragzine to the upper maker — so the session is only an operational
-- grouping per terminal, the way the carton move-out sessions in 024 are. It exists so the
-- storekeeper can print exactly what left the store in one run.
--
-- The issues themselves are the raw_material_qr_events rows carrying this session id.
-- This table holds only the session envelope, so nothing is duplicated.

CREATE TABLE IF NOT EXISTS raw_material_issue_sessions (
  id TEXT PRIMARY KEY,
  session_number INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  started_by TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  started_at TEXT NOT NULL,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('OPEN','CLOSED'))
);

CREATE INDEX IF NOT EXISTS idx_rm_issue_sessions_device_status
  ON raw_material_issue_sessions(device_id, status);
CREATE INDEX IF NOT EXISTS idx_rm_issue_sessions_started_at
  ON raw_material_issue_sessions(started_at DESC);
