import { describe, expect, it } from "vitest";
import { IncidentService } from "../src/incident-service";
import type { AuditEventInput, Incident, IncidentTrigger } from "../src/types";
import type { AuditLog, IncidentStore, WorkflowEngine } from "../src/ports";

class FakeIncidentStore implements IncidentStore {
  private incident: Incident | null = null;

  async createOrGet(_trigger: IncidentTrigger, dedupeKey: string) {
    if (this.incident) return { incident: this.incident, created: false };
    const now = new Date().toISOString();
    this.incident = {
      id: "incident-1",
      repositoryId: "repo-1",
      dedupeKey,
      triggerType: "GITHUB_WORKFLOW_RUN",
      triggerExternalId: "workflow-1",
      status: "RECEIVED",
      createdAt: now,
      updatedAt: now
    };
    return { incident: this.incident, created: true };
  }

  async getById(id: string) { return this.incident?.id === id ? this.incident : null; }
  async updateStatus(): Promise<void> {}
  async markFailedSafe(): Promise<boolean> { return true; }
}

class FakeAudit implements AuditLog {
  events = new Map<string, AuditEventInput>();
  async append(event: AuditEventInput) { this.events.set(event.idempotencyKey, event); }
}

class FakeWorkflow implements WorkflowEngine {
  ensures: string[] = [];
  actualStarts = new Set<string>();
  async ensureIncidentWorkflow(incidentId: string) {
    this.ensures.push(incidentId);
    this.actualStarts.add(incidentId);
    return { workflowId: `incident-${incidentId}` };
  }
}

const trigger: IncidentTrigger = {
  provider: "github",
  repositoryExternalId: "42",
  repositoryFullName: "acme/api",
  triggerType: "GITHUB_WORKFLOW_RUN",
  triggerExternalId: "991",
  deliveryId: "delivery-1",
  headSha: "abc",
  failureSummary: "tests failed"
};

describe("IncidentService", () => {
  it("makes redelivery idempotent while allowing it to repair workflow startup", async () => {
    const incidents = new FakeIncidentStore();
    const audit = new FakeAudit();
    const workflows = new FakeWorkflow();
    const service = new IncidentService(incidents, audit, workflows);

    const first = await service.ingest(trigger, "dedupe");
    const duplicate = await service.ingest({ ...trigger, deliveryId: "redelivery-2" }, "dedupe");

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(audit.events.size).toBe(1);
    expect(workflows.ensures).toHaveLength(2);
    expect(workflows.actualStarts.size).toBe(1);
  });
});
