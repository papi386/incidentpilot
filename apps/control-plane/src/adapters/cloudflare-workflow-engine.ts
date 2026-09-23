import type { WorkflowEngine } from "@incidentpilot/domain";

export class CloudflareWorkflowEngine implements WorkflowEngine {
  constructor(private readonly workflow: Workflow) {}

  async ensureIncidentWorkflow(incidentId: string): Promise<{ workflowId: string }> {
    const workflowId = `incident-${incidentId}`;

    try {
      await this.workflow.create({ id: workflowId, params: { incidentId } });
      return { workflowId };
    } catch (createError) {
      // Cloudflare Workflow.get(id) throws when the instance does not exist.
      // If create() lost a duplicate-delivery race, a successful get() proves
      // the deterministic instance now exists and the ensure operation is safe.
      try {
        await this.workflow.get(workflowId);
        return { workflowId };
      } catch {
        throw createError;
      }
    }
  }
}
