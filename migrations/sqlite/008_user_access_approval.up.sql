ALTER TABLE app_users ADD COLUMN role TEXT NOT NULL DEFAULT 'USER';
ALTER TABLE app_users ADD COLUMN access_status TEXT NOT NULL DEFAULT 'APPROVED';
UPDATE app_users SET role = 'ADMIN', access_status = 'APPROVED' WHERE LOWER(username) = LOWER('Moeezkhan');
CREATE TABLE IF NOT EXISTS access_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING',
  requested_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  FOREIGN KEY (user_id) REFERENCES app_users(id),
  FOREIGN KEY (reviewed_by) REFERENCES app_users(id),
  CHECK (status IN ('PENDING','APPROVED','REJECTED'))
);
CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status);