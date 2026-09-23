import type {
  IncidentAuthorizationDecision,
  IncidentAuthorizationPolicy,
  TriggerType
} from "@incidentpilot/domain";

interface PolicyRow {
  trigger_type: TriggerType;
  installation_external_id: string | null;
  known_installation_id: string | null;
  permissions_json: string | null;
  suspended_at: string | null;
  superseded: number;
}

function hasReadPermission(permissions: Record<string, unknown>, name: string): boolean {
  const value = permissions[name];
  return value === "read" || value === "write";
}

export class D1IncidentAuthorizationPolicy implements IncidentAuthorizationPolicy {
  constructor(private readonly db: D1Database) {}

  async evaluate(incidentId: string): Promise<IncidentAuthorizationDecision> {
    const row = await this.db.prepare(`
      SELECT
        i.trigger_type,
        r.installation_external_id,
        gi.external_id AS known_installation_id,
        gi.permissions_json,
        gi.suspended_at,
        EXISTS(SELECT 1 FROM incident_supersessions s WHERE s.incident_id = i.id) AS superseded
      FROM incidents i
      JOIN repositories r ON r.id = i.repository_id
      LEFT JOIN github_installations gi
        ON gi.external_id = r.installation_external_id
      WHERE i.id = ?
    `).bind(incidentId).first<PolicyRow>();

    if (row?.superseded) return { allowed: false, reason: "SUPERSEDED" };
    if (!row?.installation_external_id) {
      return { allowed: false, reason: "MISSING_INSTALLATION" };
    }
    if (!row.known_installation_id || !row.permissions_json) {
      return { allowed: false, reason: "UNKNOWN_INSTALLATION" };
    }
    if (row.suspended_at) {
      return { allowed: false, reason: "INSTALLATION_SUSPENDED" };
    }

    let permissions: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.permissions_json) as unknown;
      permissions = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      permissions = {};
    }

    const triggerPermission = row.trigger_type === "GITHUB_WORKFLOW_RUN" ? "actions" : "checks";
    if (!hasReadPermission(permissions, triggerPermission) || !hasReadPermission(permissions, "contents")) {
      return { allowed: false, reason: "INSUFFICIENT_PERMISSIONS" };
    }

    return { allowed: true, reason: "AUTHORIZED_INSTALLATION" };
  }
}
