PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  identity_provider TEXT NOT NULL CHECK (identity_provider IN ('github')),
  external_user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(identity_provider, external_user_id)
);

CREATE INDEX idx_users_provider_username
  ON users(identity_provider, username);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_user_expires
  ON sessions(user_id, expires_at);

CREATE TABLE oauth_flows (
  state_hash TEXT PRIMARY KEY,
  browser_binding_hash TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('LOGIN', 'INSTALL')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX idx_oauth_flows_expiry
  ON oauth_flows(expires_at, consumed_at);

CREATE TABLE github_installations (
  external_id TEXT PRIMARY KEY,
  account_external_id TEXT NOT NULL,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL,
  repository_selection TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  suspended_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE user_github_installations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_external_id TEXT NOT NULL REFERENCES github_installations(external_id) ON DELETE CASCADE,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(user_id, installation_external_id)
);

CREATE INDEX idx_user_installations_installation
  ON user_github_installations(installation_external_id, user_id);
