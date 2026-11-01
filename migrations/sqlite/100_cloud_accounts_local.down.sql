-- Puts password checks back into app_users, and narrows access_status back, removing REVOKED.
--
-- WRITTEN TO FAIL when it would lose information. Any account with an email (it came from, or
-- moved to, cloud accounts), any account REVOKED, and any account with no password check on this
-- PC (a person from the cloud who never signed in here) has nowhere to go in 099's shape. The
-- guard's CHECK refuses the first such row and the whole migration rolls back. Mapping REVOKED to
-- REJECTED, or giving a person an empty hash, would silently change who can sign in.
--
-- Nothing executes this file: the runner reads *.up.sql only. It exists so the forward migration
-- can be read against its inverse.
--
-- (No semicolons in comments.)

CREATE TEMP TABLE down_100_guard (accounts_that_would_be_lost INTEGER NOT NULL CHECK (accounts_that_would_be_lost = 0));

INSERT INTO down_100_guard (accounts_that_would_be_lost)
SELECT COUNT(*) FROM app_users u LEFT JOIN user_credentials c ON c.user_id = u.id
WHERE u.email IS NOT NULL OR u.access_status = 'REVOKED' OR c.user_id IS NULL;

DROP TABLE down_100_guard;

CREATE TABLE app_users_old (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'USER',
  authority_level INTEGER NOT NULL DEFAULT 10,
  job_role TEXT NOT NULL DEFAULT '',
  role_notification TEXT,
  access_status TEXT NOT NULL DEFAULT 'PENDING',
  permissions_json TEXT NOT NULL DEFAULT '[]',
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (role IN ('USER','ADMIN')),
  CHECK (access_status IN ('PENDING','APPROVED','REJECTED'))
);

INSERT INTO app_users_old (id, username, password_hash, password_salt, role, authority_level, job_role, role_notification, access_status, permissions_json, last_login_at, created_at, updated_at)
SELECT u.id, u.username, c.password_hash, c.password_salt, u.role, u.authority_level, u.job_role,
       u.role_notification, u.access_status, u.permissions_json, u.last_login_at, u.created_at, u.updated_at
FROM app_users u JOIN user_credentials c ON c.user_id = u.id;

DROP TABLE user_credentials;

DROP TABLE app_users;

ALTER TABLE app_users_old RENAME TO app_users;

CREATE INDEX IF NOT EXISTS idx_app_users_username ON app_users(username);
