-- Routing decisions contain only validated provider IDs and fixed reason codes.

ALTER TABLE github_webhook_deliveries
ADD COLUMN disposition TEXT
CHECK (
  disposition IN (
    'CANONICAL_TRIGGER',
    'SUPPORTING_ONLY',
    'INDEPENDENT_TRIGGER',
    'PENDING_VERIFICATION',
    'REJECTED'
  )
);

ALTER TABLE github_webhook_deliveries
ADD COLUMN routing_reason TEXT;

ALTER TABLE github_webhook_deliveries
ADD COLUMN repository_external_id TEXT;

ALTER TABLE github_webhook_deliveries
ADD COLUMN installation_external_id TEXT;

ALTER TABLE github_webhook_deliveries
ADD COLUMN source_external_id TEXT;

ALTER TABLE github_webhook_deliveries
ADD COLUMN source_app_id TEXT;

ALTER TABLE github_webhook_deliveries
ADD COLUMN check_suite_id TEXT;

ALTER TABLE github_webhook_deliveries
ADD COLUMN routing_version INTEGER;


-- Preserve the historical meaning of already-processed deliveries.
--
-- Intentionally use two UPDATE statements instead of CASE.
-- Wrangler/D1 migration splitting is sensitive to CASE ... END around
-- trigger-bearing migrations.
UPDATE github_webhook_deliveries
SET
  disposition = 'CANONICAL_TRIGGER',
  routing_reason = 'LEGACY_PRE_ROUTER',
  routing_version = 0
WHERE processed_at IS NOT NULL
  AND event_name = 'workflow_run';

UPDATE github_webhook_deliveries
SET
  disposition = 'INDEPENDENT_TRIGGER',
  routing_reason = 'LEGACY_PRE_ROUTER',
  routing_version = 0
WHERE processed_at IS NOT NULL
  AND event_name <> 'workflow_run';


-- Operator-managed trust.
-- Never populate this table from webhook-controlled content.
CREATE TABLE trusted_check_providers (
  installation_external_id TEXT NOT NULL,
  repository_external_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0
    CHECK (enabled IN (0, 1)),

  PRIMARY KEY (
    installation_external_id,
    repository_external_id,
    app_id
  )
);


-- Supersession is explicit and immutable.
--
-- Existing incidents/evidence/audit history are retained.
-- Execution policy consumes this relationship as a deny condition.
CREATE TABLE incident_supersessions (
  incident_id TEXT PRIMARY KEY
    REFERENCES incidents(id),

  canonical_incident_id TEXT NOT NULL
    REFERENCES incidents(id),

  reason TEXT NOT NULL
    CHECK (
      reason = 'GITHUB_ACTIONS_CHECK_DUPLICATE'
    ),

  recorded_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL,

  CHECK (
    incident_id <> canonical_incident_id
  )
);


-- Validate an operator-recorded supersession relationship.
--
-- No CASE expression is used here. SELECT RAISE(...) WHERE ...
-- keeps the trigger simple for Wrangler's SQL splitter.
CREATE TRIGGER validate_incident_supersession
BEFORE INSERT ON incident_supersessions
BEGIN
  SELECT RAISE(
    ABORT,
    'Conflicting supersession relationship'
  )
  WHERE EXISTS (
    SELECT 1
    FROM incident_supersessions
    WHERE incident_id = NEW.incident_id
      AND canonical_incident_id <> NEW.canonical_incident_id
  );

  SELECT RAISE(
    ABORT,
    'Invalid supersession relationship'
  )
  WHERE NOT EXISTS (
    SELECT 1
    FROM incidents AS old
    JOIN incidents AS canonical
      ON old.repository_id = canonical.repository_id
    WHERE old.id = NEW.incident_id
      AND canonical.id = NEW.canonical_incident_id
      AND old.trigger_type = 'GITHUB_CHECK_RUN'
      AND canonical.trigger_type = 'GITHUB_WORKFLOW_RUN'
      AND old.head_sha IS NOT NULL
      AND old.head_sha = canonical.head_sha
      AND NOT EXISTS (
        SELECT 1
        FROM incident_supersessions
        WHERE incident_id = canonical.id
      )
  );
END;


CREATE TRIGGER immutable_incident_supersession_update
BEFORE UPDATE ON incident_supersessions
BEGIN
  SELECT RAISE(
    ABORT,
    'Supersession records are immutable'
  );
END;


CREATE TRIGGER immutable_incident_supersession_delete
BEFORE DELETE ON incident_supersessions
BEGIN
  SELECT RAISE(
    ABORT,
    'Supersession records are immutable'
  );
END;