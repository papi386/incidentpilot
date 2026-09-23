-- Apply only after migration 0007. This records the relationship explicitly
-- confirmed by the operator in the E2E report; it does not infer it from SHA.
-- Each prefix must resolve to exactly one incident, otherwise NOT NULL fails.
-- The DB trigger also verifies repository, SHA and trigger types.
-- No incidents, evidence, or existing audit events are deleted or rewritten.
INSERT INTO incident_supersessions (
  incident_id, canonical_incident_id, reason, recorded_at, recorded_by
) VALUES (
  (SELECT CASE WHEN COUNT(*) = 1 THEN MIN(id) ELSE NULL END FROM incidents WHERE id = 'f1646d3a-01f7-499a-b7a5-9dfaa97e46aa'),
  (SELECT CASE WHEN COUNT(*) = 1 THEN MIN(id) ELSE NULL END FROM incidents WHERE id = '96ad8991-dad6-4e93-805a-ed3ba1146359'),
  'GITHUB_ACTIONS_CHECK_DUPLICATE', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'operator-confirmed-e2e'
)
ON CONFLICT(incident_id) DO NOTHING;

SELECT s.incident_id, s.canonical_incident_id, s.reason, s.recorded_at,
       i.status AS original_status, 'NON_ACTIONABLE' AS execution_disposition
FROM incident_supersessions s JOIN incidents i ON i.id = s.incident_id
WHERE s.incident_id LIKE 'f1646d3a%';
