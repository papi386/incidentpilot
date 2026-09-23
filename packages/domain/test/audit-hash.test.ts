import { describe, expect, it } from "vitest";
import { computeAuditHash } from "../src/audit-hash";

const base = {
  idempotencyKey: "status:i:RECEIVED->VALIDATING",
  incidentId: "i",
  actorType: "SYSTEM" as const,
  actorId: "workflow",
  eventType: "INCIDENT_STATUS_CHANGED",
  occurredAt: "2026-09-10T00:00:00.000Z"
};

describe("audit hash", () => {
  it("is stable when metadata key insertion order differs", async () => {
    const a = await computeAuditHash("GENESIS", { ...base, metadata: { from: "RECEIVED", to: "VALIDATING" } });
    const b = await computeAuditHash("GENESIS", { ...base, metadata: { to: "VALIDATING", from: "RECEIVED" } });
    expect(a).toBe(b);
  });

  it("links the previous event hash", async () => {
    const event = { ...base, metadata: { from: "RECEIVED", to: "VALIDATING" } };
    expect(await computeAuditHash("A", event)).not.toBe(await computeAuditHash("B", event));
  });
});
