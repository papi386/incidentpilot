import { computeAuditHash, type AuditEventInput, type AuditLog } from "@incidentpilot/domain";

interface LatestHashRow { event_hash: string; }
interface ExistingRow { id: string; }

export class D1AuditLog implements AuditLog {
  constructor(private readonly db: D1Database) {}

  async append(event: AuditEventInput): Promise<void> {
    const existing = await this.db.prepare(`
      SELECT id FROM audit_events WHERE idempotency_key = ? LIMIT 1
    `).bind(event.idempotencyKey).first<ExistingRow>();
    if (existing) return;

    // V1 has one ordered workflow per incident. Later, when tool/model workers can
    // append concurrently, this becomes a dedicated per-incident audit sequencer.
    const latest = await this.db.prepare(`
      SELECT event_hash FROM audit_events
      WHERE incident_id = ? ORDER BY sequence DESC LIMIT 1
    `).bind(event.incidentId).first<LatestHashRow>();

    const previousHash = latest?.event_hash ?? "GENESIS";
    const eventHash = await computeAuditHash(previousHash, event);

    await this.db.prepare(`
      INSERT INTO audit_events (
        id, idempotency_key, incident_id, actor_type, actor_id, event_type, metadata_json,
        occurred_at, previous_event_hash, event_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).bind(
      crypto.randomUUID(),
      event.idempotencyKey,
      event.incidentId,
      event.actorType,
      event.actorId,
      event.eventType,
      JSON.stringify(event.metadata),
      event.occurredAt,
      previousHash,
      eventHash
    ).run();
  }
}
