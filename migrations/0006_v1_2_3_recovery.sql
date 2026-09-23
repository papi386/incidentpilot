PRAGMA foreign_keys = ON;

-- V1.2.2 item AAD depended on the original plaintext dedupe key, which was
-- intentionally not persisted. Pre-production snapshots are invalidated and
-- both evidence tables are rebuilt for recoverable AAD v2.
DELETE FROM evidence_edges;
DELETE FROM evidence_items;
DELETE FROM evidence_collection_runs;

DROP TABLE evidence_edges;
DROP TABLE evidence_items;

CREATE TABLE evidence_items (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'WORKFLOW_RUN','WORKFLOW_JOB','JOB_LOG_EXCERPT','CHECK_RUN','CHECK_OUTPUT',
    'CHANGED_FILE','DIFF_HUNK','ERROR_SIGNAL','FAILING_TEST','STACK_FRAME'
  )),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('GITHUB_API','GITHUB_REDIRECT','DERIVED')),
  source_external_id TEXT,
  source_url TEXT,
  integrity TEXT NOT NULL CHECK (integrity IN ('PROVIDER_AUTHENTICATED','DERIVED_FROM_AUTHENTICATED')),
  content_class TEXT NOT NULL CHECK (content_class IN ('STRUCTURED_METADATA','UNTRUSTED_TEXT')),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('NORMAL','POTENTIALLY_SENSITIVE')),
  instruction_trust TEXT NOT NULL CHECK (instruction_trust = 'NEVER_INSTRUCTIONS'),
  ciphertext_b64 TEXT NOT NULL,
  nonce_b64 TEXT NOT NULL,
  aad_version INTEGER NOT NULL CHECK (aad_version = 2),
  key_version TEXT NOT NULL CHECK (length(key_version) BETWEEN 1 AND 32),
  metadata_json TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  UNIQUE(incident_id, dedupe_key)
);

CREATE INDEX idx_evidence_incident_kind
  ON evidence_items(incident_id, kind, collected_at);

CREATE INDEX idx_evidence_incident_source
  ON evidence_items(incident_id, source_kind, source_external_id);

CREATE TABLE evidence_edges (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  from_evidence_id TEXT NOT NULL REFERENCES evidence_items(id) ON DELETE CASCADE,
  to_evidence_id TEXT NOT NULL REFERENCES evidence_items(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (relation IN ('DERIVED_FROM','RELATED_TO','POINTS_TO_FILE')),
  ciphertext_b64 TEXT NOT NULL,
  nonce_b64 TEXT NOT NULL,
  aad_version INTEGER NOT NULL CHECK (aad_version = 2),
  key_version TEXT NOT NULL CHECK (length(key_version) BETWEEN 1 AND 32),
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(incident_id, from_evidence_id, to_evidence_id, relation)
);

CREATE INDEX idx_evidence_edges_incident
  ON evidence_edges(incident_id, from_evidence_id, relation);
