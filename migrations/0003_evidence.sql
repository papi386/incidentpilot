PRAGMA foreign_keys = ON;

-- Runtime emergency controls. Future-risk capabilities default OFF.
CREATE TABLE runtime_controls (
  control_key TEXT PRIMARY KEY CHECK (control_key IN (
    'webhook_ingestion_enabled',
    'evidence_collection_enabled',
    'model_calls_enabled',
    'privileged_actions_enabled'
  )),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  updated_at TEXT NOT NULL
);

INSERT INTO runtime_controls (control_key, enabled, updated_at) VALUES
  ('webhook_ingestion_enabled', 1, CURRENT_TIMESTAMP),
  ('evidence_collection_enabled', 1, CURRENT_TIMESTAMP),
  ('model_calls_enabled', 0, CURRENT_TIMESTAMP),
  ('privileged_actions_enabled', 0, CURRENT_TIMESTAMP);

-- Replay/conflict ledger for authenticated GitHub deliveries.
CREATE TABLE github_webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
  first_seen_at TEXT NOT NULL,
  processed_at TEXT,
  incident_id TEXT REFERENCES incidents(id) ON DELETE SET NULL
);

CREATE INDEX idx_github_webhook_delivery_incident
  ON github_webhook_deliveries(incident_id, first_seen_at);

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

  -- Sanitized evidence is encrypted again at the application layer using
  -- AES-256-GCM. No plaintext content column exists in D1.
  ciphertext_b64 TEXT NOT NULL,
  nonce_b64 TEXT NOT NULL,
  aad_version INTEGER NOT NULL CHECK (aad_version = 1),
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
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(incident_id, from_evidence_id, to_evidence_id, relation)
);

CREATE INDEX idx_evidence_edges_incident
  ON evidence_edges(incident_id, from_evidence_id, relation);

CREATE TABLE evidence_collection_runs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('github')),
  status TEXT NOT NULL CHECK (status IN ('COMPLETED','PARTIAL','FAILED')),
  requests_used INTEGER NOT NULL CHECK (requests_used >= 0),
  downloaded_bytes INTEGER NOT NULL CHECK (downloaded_bytes >= 0),
  items_produced INTEGER NOT NULL CHECK (items_produced >= 0),
  edges_produced INTEGER NOT NULL CHECK (edges_produced >= 0),
  truncated INTEGER NOT NULL CHECK (truncated IN (0,1)),
  error_codes_json TEXT NOT NULL,
  base_resolution TEXT NOT NULL CHECK (base_resolution IN ('INCIDENT','WORKFLOW_PULL_REQUEST','HEAD_PARENT','UNAVAILABLE')),
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  UNIQUE(incident_id, source)
);

CREATE INDEX idx_evidence_collection_incident
  ON evidence_collection_runs(incident_id, completed_at DESC);
