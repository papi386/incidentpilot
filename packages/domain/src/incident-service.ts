import type { AuditLog, IncidentStore, WorkflowEngine } from "./ports";
import type { IncidentTrigger } from "./types";

export class IncidentService {
  constructor(
    private readonly incidents: IncidentStore,
    private readonly audit: AuditLog,
    private readonly workflows: WorkflowEngine
  ) {}

  async ingest(trigger: IncidentTrigger, dedupeKey: string) {
    const result = await this.incidents.createOrGet(trigger, dedupeKey);

    // The audit event is itself idempotent. Calling it again is intentional: if a
    // previous request created the incident but crashed before audit persistence,
    // a redelivery repairs the partial operation.
    await this.audit.append({
      idempotencyKey: `incident-created:${result.incident.id}`,
      incidentId: result.incident.id,
      actorType: "GITHUB",
      actorId: trigger.deliveryId,
      eventType: "INCIDENT_CREATED",
      occurredAt: result.incident.createdAt,
      metadata: {
        provider: trigger.provider,
        triggerType: trigger.triggerType,
        triggerExternalId: trigger.triggerExternalId
      }
    });

    // "Ensure", rather than "start only if created", makes webhook redelivery a
    // recovery mechanism if persistence succeeded but Workflow creation failed.
    const workflow = await this.workflows.ensureIncidentWorkflow(result.incident.id);
    return { ...result, workflowId: workflow.workflowId };
  }
}
