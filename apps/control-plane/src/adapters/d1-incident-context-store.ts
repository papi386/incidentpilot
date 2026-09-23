import type { IncidentEvidenceContext, IncidentStatus, IncidentContextStore, TriggerType } from "@incidentpilot/domain";

interface ContextRow {
  id: string;
  repository_id: string;
  dedupe_key: string;
  trigger_type: TriggerType;
  trigger_external_id: string;
  base_sha: string | null;
  head_sha: string | null;
  status: IncidentStatus;
  created_at: string;
  updated_at: string;
  repository_external_id: string;
  repository_full_name: string;
  installation_external_id: string | null;
}

export class D1IncidentContextStore implements IncidentContextStore {
  constructor(private readonly db: D1Database) {}

  async getEvidenceContext(incidentId: string): Promise<IncidentEvidenceContext | null> {
    const row = await this.db.prepare(`
      SELECT
        i.id,
        i.repository_id,
        i.dedupe_key,
        i.trigger_type,
        i.trigger_external_id,
        i.base_sha,
        i.head_sha,
        i.status,
        i.created_at,
        i.updated_at,
        r.external_id AS repository_external_id,
        r.full_name AS repository_full_name,
        r.installation_external_id
      FROM incidents i
      JOIN repositories r ON r.id = i.repository_id
      WHERE i.id = ?
    `).bind(incidentId).first<ContextRow>();

    if (!row) return null;

    return {
      incident: {
        id: row.id,
        repositoryId: row.repository_id,
        dedupeKey: row.dedupe_key,
        triggerType: row.trigger_type,
        triggerExternalId: row.trigger_external_id,
        ...(row.base_sha ? { baseSha: row.base_sha } : {}),
        ...(row.head_sha ? { headSha: row.head_sha } : {}),
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      },
      provider: "github",
      repositoryExternalId: row.repository_external_id,
      repositoryFullName: row.repository_full_name,
      ...(row.installation_external_id
        ? { installationExternalId: row.installation_external_id }
        : {}),
      triggerType: row.trigger_type,
      triggerExternalId: row.trigger_external_id,
      ...(row.base_sha ? { baseSha: row.base_sha } : {}),
      ...(row.head_sha ? { headSha: row.head_sha } : {})
    };
  }
}
