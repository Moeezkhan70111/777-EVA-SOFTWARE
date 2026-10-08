ALTER TABLE app_users ADD COLUMN authority_level INTEGER NOT NULL DEFAULT 10;
UPDATE app_users SET authority_level = 100 WHERE role = 'ADMIN';