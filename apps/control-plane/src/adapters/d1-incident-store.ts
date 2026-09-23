import type {
  CreateIncidentResult,
  Incident,
  IncidentFailureCode,
  IncidentStatus,
  IncidentStore,
  IncidentTrigger
} from "@incidentpilot/domain";

interface IncidentRow {
  id: string;
  repository_id: string;
  dedupe_key: string;
  trigger_type: Incident["triggerType"];
  trigger_external_id: string;
  base_sha: string | null;
  head_sha: string | null;
  status: IncidentStatus;
  failure_code: IncidentFailureCode | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: IncidentRow): Incident {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    dedupeKey: row.dedupe_key,
    triggerType: row.trigger_type,
    triggerExternalId: row.trigger_external_id,
    ...(row.base_sha ? { baseSha: row.base_sha } : {}),
    ...(row.head_sha ? { headSha: row.head_sha } : {}),
    status: row.status,
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class D1IncidentStore implements IncidentStore {
  constructor(private readonly db: D1Database) {}

  async isSuperseded(id: string): Promise<boolean> {
    return (await this.db.prepare("SELECT incident_id FROM incident_supersessions WHERE incident_id = ?")
      .bind(id).first()) !== null;
  }

  async createOrGet(trigger: IncidentTrigger, dedupeKey: string): Promise<CreateIncidentResult> {
    const repositoryId = `github:${trigger.repositoryExternalId}`;
    const now = new Date().toISOString();

    await this.db.prepare(`
      INSERT INTO repositories (
        id, provider, external_id, full_name, installation_external_id, created_at, updated_at
      ) VALUES (?, 'github', ?, ?, ?, ?, ?)
      ON CONFLICT(provider, external_id) DO UPDATE SET
        full_name = excluded.full_name,
        installation_external_id = COALESCE(excluded.installation_external_id, repositories.installation_external_id),
        updated_at = excluded.updated_at
    `).bind(
      repositoryId,
      trigger.repositoryExternalId,
      trigger.repositoryFullName,
      trigger.installationExternalId ?? null,
      now,
      now
    ).run();

    const candidateId = crypto.randomUUID();
    const insert = await this.db.prepare(`
      INSERT INTO incidents (
        id, repository_id, dedupe_key, trigger_type, trigger_external_id,
        base_sha, head_sha, failure_summary, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?, ?)
      ON CONFLICT(repository_id, dedupe_key) DO NOTHING
    `).bind(
      candidateId,
      repositoryId,
      dedupeKey,
      trigger.triggerType,
      trigger.triggerExternalId,
      trigger.baseSha ?? null,
      trigger.headSha ?? null,
      trigger.failureSummary,
      now,
      now
    ).run();

    const row = await this.db.prepare(`
      SELECT id, repository_id, dedupe_key, trigger_type, trigger_external_id,
             base_sha, head_sha, status, failure_code, created_at, updated_at
      FROM incidents
      WHERE repository_id = ? AND dedupe_key = ?
    `).bind(repositoryId, dedupeKey).first<IncidentRow>();

    if (!row) throw new Error("Incident insert/read invariant failed");
    return { incident: mapRow(row), created: insert.meta.changes === 1 };
  }

  async getById(id: string): Promise<Incident | null> {
    const row = await this.db.prepare(`
      SELECT id, repository_id, dedupe_key, trigger_type, trigger_external_id,
             base_sha, head_sha, status, failure_code, created_at, updated_at
      FROM incidents WHERE id = ?
    `).bind(id).first<IncidentRow>();
    return row ? mapRow(row) : null;
  }

  async updateStatus(id: string, next: IncidentStatus): Promise<void> {
    const result = await this.db.prepare(`
      UPDATE incidents SET status = ?, updated_at = ? WHERE id = ?
    `).bind(next, new Date().toISOString(), id).run();
    if (result.meta.changes !== 1) throw new Error(`Incident not found: ${id}`);
  }
  async markFailedSafe(id: string, failureCode: IncidentFailureCode): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE incidents
      SET status = 'FAILED_SAFE', failure_code = ?, updated_at = ?
      WHERE id = ?
        AND status IN (
          'RECEIVED','VALIDATING','AUTHORIZED','TRIAGING','CONTEXT_BUILDING','INVESTIGATING',
          'DIAGNOSIS_READY','AUTONOMY_GATE','NEEDS_HUMAN','PATCH_PLANNING','PATCH_GENERATING',
          'PATCH_STATIC_VALIDATION','VERIFYING','REPLAN','VERIFIED','ACTION_POLICY_GATE',
          'REPORT_ONLY','CREATE_DRAFT_PR'
        )
    `).bind(failureCode, new Date().toISOString(), id).run();

    return result.meta.changes === 1;
  }

}
