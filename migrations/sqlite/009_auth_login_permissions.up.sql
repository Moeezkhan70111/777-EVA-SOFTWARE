ALTER TABLE app_users ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE app_users ADD COLUMN last_login_at TEXT;
ALTER TABLE user_sessions ADD COLUMN login_date TEXT NOT NULL DEFAULT '';
UPDATE user_sessions SET login_date = substr(created_at, 1, 10) WHERE login_date = '';
UPDATE app_users SET permissions_json = '["dashboard","scanning","inventory","masters","billing","settings","health","logs"]' WHERE permissions_json = '[]' AND access_status = 'APPROVED';