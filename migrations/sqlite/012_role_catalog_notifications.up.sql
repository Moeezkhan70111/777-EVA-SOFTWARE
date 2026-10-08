CREATE TABLE IF NOT EXISTS job_role_options (name TEXT PRIMARY KEY, created_at TEXT NOT NULL);
INSERT OR IGNORE INTO job_role_options (name, created_at) SELECT job_role, created_at FROM app_users WHERE TRIM(job_role) <> '';
CREATE TABLE IF NOT EXISTS user_notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT, FOREIGN KEY (user_id) REFERENCES app_users(id));
CREATE INDEX IF NOT EXISTS idx_user_notifications_user ON user_notifications(user_id, created_at);