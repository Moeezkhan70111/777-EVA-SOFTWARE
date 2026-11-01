-- 100: cloud accounts, the local half (docs/41 section 2).
--
-- PASSWORD CHECKS LEAVE app_users. They move to user_credentials, which never replicates. In local
-- mode it holds each account's password check exactly as app_users did, same PBKDF2 hash and salt,
-- so every existing sign-in keeps working unchanged. In cloud mode it is this PC's cache: a check
-- made at a successful online sign-in, valid only while its credential_version matches the one the
-- cloud last told this PC.
--
-- app_users IS REBUILT, because SQLite cannot change a CHECK or drop a column in place:
--   * the password columns go
--   * access_status gains REVOKED (access removed by an admin), separate from REJECTED (a request
--     declined)
--   * email: how a person signs in under cloud accounts. Null for a local-mode account.
--   * credential_version: the latest the cloud has told this PC for this person
--   * username stays unique among LOCAL accounts, which sign in with it. A person from the cloud
--     signs in by email and their username is a display name, which two people may share.
--
-- Every other table that names app_users(id) keeps naming the same ids. The runner holds
-- foreign keys off for the whole run, as for 019's rebuild of parties.

CREATE TABLE IF NOT EXISTS user_credentials (
  user_id TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version >= 1),
  confirmed_online_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES app_users(id)
);

INSERT INTO user_credentials (user_id, password_hash, password_salt, credential_version, confirmed_online_at, updated_at)
SELECT id, password_hash, password_salt, 1, NULL, updated_at FROM app_users;

CREATE TABLE app_users_new (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'USER',
  authority_level INTEGER NOT NULL DEFAULT 10,
  job_role TEXT NOT NULL DEFAULT '',
  role_notification TEXT,
  access_status TEXT NOT NULL DEFAULT 'PENDING',
  permissions_json TEXT NOT NULL DEFAULT '[]',
  last_login_at TEXT,
  credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (role IN ('USER','ADMIN')),
  CHECK (access_status IN ('PENDING','APPROVED','REJECTED','REVOKED'))
);

INSERT INTO app_users_new (id, username, email, role, authority_level, job_role, role_notification, access_status, permissions_json, last_login_at, credential_version, created_at, updated_at)
SELECT id, username, NULL, role, authority_level, job_role, role_notification, access_status, permissions_json, last_login_at, 1, created_at, updated_at
FROM app_users;

DROP TABLE app_users;

ALTER TABLE app_users_new RENAME TO app_users;

CREATE INDEX IF NOT EXISTS idx_app_users_username ON app_users(username);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_local_username ON app_users(username) WHERE email IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_email ON app_users(email COLLATE NOCASE) WHERE email IS NOT NULL;
