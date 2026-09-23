PRAGMA foreign_keys = ON;

CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('github')),
  external_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  installation_external_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, external_id)
);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('GITHUB_WORKFLOW_RUN', 'GITHUB_CHECK_RUN')),
  trigger_external_id TEXT NOT NULL,
  base_sha TEXT,
  head_sha TEXT,
  failure_summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'RECEIVED','VALIDATING','AUTHORIZED','TRIAGING','CONTEXT_BUILDING','INVESTIGATING',
    'DIAGNOSIS_READY','AUTONOMY_GATE','NEEDS_HUMAN','PATCH_PLANNING','PATCH_GENERATING',
    'PATCH_STATIC_VALIDATION','VERIFYING','REPLAN','VERIFIED','ACTION_POLICY_GATE',
    'REPORT_ONLY','CREATE_DRAFT_PR','COMPLETED','REJECTED','POLICY_DENIED','BUDGET_EXHAUSTED',
    'SECURITY_ABORTED','FAILED_SAFE','CANCELLED'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repository_id, dedupe_key)
);

CREATE INDEX idx_incidents_repository_status
  ON incidents(repository_id, status, created_at DESC);

CREATE TABLE audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('SYSTEM','GITHUB','USER','AGENT')),
  actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  previous_event_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL UNIQUE
);

CREATE INDEX idx_audit_incident_sequence
  ON audit_events(incident_id, sequence);
