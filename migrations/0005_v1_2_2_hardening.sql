PRAGMA foreign_keys = ON;

CREATE INDEX IF NOT EXISTS idx_oauth_flows_active_expiry
  ON oauth_flows(consumed_at, expires_at, created_at);

CREATE TABLE github_installation_sync_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  updated_at TEXT NOT NULL
);

ALTER TABLE user_github_installations
  ADD COLUMN sync_generation INTEGER NOT NULL DEFAULT 0 CHECK (sync_generation >= 0);

CREATE INDEX idx_user_installations_sync_generation
  ON user_github_installations(user_id, sync_generation);

-- V1.2.1 allowed repository-derived evidence metadata outside ciphertext.
-- This is a pre-production migration: invalidate old snapshots rather than
-- preserving historical plaintext metadata/dedupe keys.
DELETE FROM evidence_edges;
DELETE FROM evidence_items;
DELETE FROM evidence_collection_runs;
