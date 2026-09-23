import { WEBHOOK_DELIVERY_PRUNE_BATCH, WEBHOOK_DELIVERY_RETENTION_MS } from "../security/resource-limits";
import type { SourceRouting, SourceDisposition } from "../github/source-router";

export type DeliveryClaim =
  | { status: "NEW_OR_INCOMPLETE" }
  | { status: "ALREADY_PROCESSED"; incidentId: string | null; disposition: SourceDisposition; reason: string }
  | { status: "CONFLICT" };

interface DeliveryRow {
  event_name: string;
  body_sha256: string;
  incident_id: string | null;
  processed_at: string | null;
  disposition: SourceDisposition | null;
  routing_reason: string | null;
}

export class D1WebhookDeliveryStore {
  constructor(private readonly db: D1Database) {}

  async claim(deliveryId: string, eventName: string, bodySha256: string): Promise<DeliveryClaim> {
    const now = new Date().toISOString();
    await this.db.prepare(`
      INSERT INTO github_webhook_deliveries (
        delivery_id, event_name, body_sha256, first_seen_at, processed_at, incident_id
      ) VALUES (?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(delivery_id) DO NOTHING
    `).bind(deliveryId, eventName, bodySha256, now).run();

    const row = await this.db.prepare(`
      SELECT event_name, body_sha256, incident_id, processed_at, disposition, routing_reason
      FROM github_webhook_deliveries
      WHERE delivery_id = ?
    `).bind(deliveryId).first<DeliveryRow>();

    if (!row) throw new Error("Webhook delivery claim invariant failed");
    if (row.event_name !== eventName || row.body_sha256 !== bodySha256) {
      return { status: "CONFLICT" };
    }
    if (row.processed_at) {
      if (!row.disposition || !row.routing_reason) throw new Error("Processed routing invariant failed");
      return { status: "ALREADY_PROCESSED", incidentId: row.incident_id, disposition: row.disposition, reason: row.routing_reason };
    }
    return { status: "NEW_OR_INCOMPLETE" };
  }

  async recordRouting(deliveryId: string, bodySha256: string, route: SourceRouting): Promise<Pick<SourceRouting, "disposition" | "reason">> {
    // First decision wins, including concurrent redeliveries and policy changes.
    await this.db.prepare(`UPDATE github_webhook_deliveries SET
      disposition = ?, routing_reason = ?, repository_external_id = ?, installation_external_id = ?,
      source_external_id = ?, source_app_id = ?, check_suite_id = ?, routing_version = 1
      WHERE delivery_id = ? AND body_sha256 = ? AND disposition IS NULL`)
      .bind(route.disposition, route.reason, route.repositoryId ?? null, route.installationId ?? null,
        route.sourceId ?? null, route.appId ?? null, route.checkSuiteId ?? null, deliveryId, bodySha256).run();
    const row = await this.db.prepare(`SELECT disposition, routing_reason FROM github_webhook_deliveries
      WHERE delivery_id = ? AND body_sha256 = ?`).bind(deliveryId, bodySha256)
      .first<{ disposition: SourceDisposition; routing_reason: string }>();
    if (!row?.disposition) throw new Error("Routing persistence invariant failed");
    return { disposition: row.disposition, reason: row.routing_reason };
  }

  async markProcessed(deliveryId: string, bodySha256: string, incidentId: string | null): Promise<void> {
    const result = await this.db.prepare(`
      UPDATE github_webhook_deliveries
      SET incident_id = ?, processed_at = ?
      WHERE delivery_id = ? AND body_sha256 = ?
        AND (incident_id IS NULL OR incident_id = ?)
        AND ((? IS NULL AND disposition IN ('SUPPORTING_ONLY','PENDING_VERIFICATION','REJECTED'))
          OR (? IS NOT NULL AND disposition IN ('CANONICAL_TRIGGER','INDEPENDENT_TRIGGER')))
    `).bind(
      incidentId,
      new Date().toISOString(),
      deliveryId,
      bodySha256,
      incidentId,
      incidentId,
      incidentId
    ).run();

    if (result.meta.changes !== 1) {
      throw new Error("Webhook delivery processing invariant failed");
    }
  }
  async pruneExpired(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - WEBHOOK_DELIVERY_RETENTION_MS).toISOString();
    const result = await this.db.prepare(`
      DELETE FROM github_webhook_deliveries
      WHERE delivery_id IN (
        SELECT delivery_id
        FROM github_webhook_deliveries
        WHERE first_seen_at < ?
        ORDER BY first_seen_at ASC
        LIMIT ?
      )
    `).bind(cutoff, WEBHOOK_DELIVERY_PRUNE_BATCH).run();

    return result.meta.changes ?? 0;
  }

}
