PRAGMA foreign_keys = ON;

-- Resource exhaustion is a failure reason, not a new lifecycle state. The
-- incident remains in FAILED_SAFE so downstream code has one fail-closed state,
-- while operators can distinguish quota/capacity exhaustion from other errors.
ALTER TABLE incidents
  ADD COLUMN failure_code TEXT
  CHECK (failure_code IS NULL OR failure_code IN ('RESOURCE_EXHAUSTED'));

CREATE INDEX idx_incidents_failure_code
  ON incidents(status, failure_code, updated_at DESC);

-- Retention cleanup filters on first_seen_at. Without this index, periodic
-- pruning would itself scan the replay ledger and increase D1 row-read usage.
CREATE INDEX idx_github_webhook_deliveries_first_seen
  ON github_webhook_deliveries(first_seen_at, delivery_id);
