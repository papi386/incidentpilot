import type { AuditEventInput } from "./types";

function stableMetadata(metadata: AuditEventInput["metadata"]): string {
  const ordered = Object.keys(metadata)
    .sort()
    .reduce<Record<string, string | number | boolean | null>>((acc, key) => {
      acc[key] = metadata[key] ?? null;
      return acc;
    }, {});
  return JSON.stringify(ordered);
}

export function canonicalAuditEvent(event: AuditEventInput): string {
  return [
    event.idempotencyKey,
    event.incidentId,
    event.actorType,
    event.actorId,
    event.eventType,
    event.occurredAt,
    stableMetadata(event.metadata)
  ].join("\n");
}

export async function computeAuditHash(
  previousHash: string,
  event: AuditEventInput
): Promise<string> {
  const payload = new TextEncoder().encode(`${previousHash}\n${canonicalAuditEvent(event)}`);
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
