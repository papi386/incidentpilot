export const INCIDENT_STATUSES = [
  "RECEIVED",
  "VALIDATING",
  "AUTHORIZED",
  "TRIAGING",
  "CONTEXT_BUILDING",
  "INVESTIGATING",
  "DIAGNOSIS_READY",
  "AUTONOMY_GATE",
  "NEEDS_HUMAN",
  "PATCH_PLANNING",
  "PATCH_GENERATING",
  "PATCH_STATIC_VALIDATION",
  "VERIFYING",
  "REPLAN",
  "VERIFIED",
  "ACTION_POLICY_GATE",
  "REPORT_ONLY",
  "CREATE_DRAFT_PR",
  "COMPLETED",
  "REJECTED",
  "POLICY_DENIED",
  "BUDGET_EXHAUSTED",
  "SECURITY_ABORTED",
  "FAILED_SAFE",
  "CANCELLED"
] as const;

export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export type IncidentFailureCode = "RESOURCE_EXHAUSTED";

export type TriggerType = "GITHUB_WORKFLOW_RUN" | "GITHUB_CHECK_RUN";

export interface IncidentTrigger {
  provider: "github";
  repositoryExternalId: string;
  repositoryFullName: string;
  installationExternalId?: string;
  triggerType: TriggerType;
  triggerExternalId: string;
  deliveryId: string;
  baseSha?: string;
  headSha?: string;
  failureSummary: string;
}

export interface Incident {
  id: string;
  repositoryId: string;
  dedupeKey: string;
  triggerType: TriggerType;
  triggerExternalId: string;
  baseSha?: string;
  headSha?: string;
  status: IncidentStatus;
  failureCode?: IncidentFailureCode;
  createdAt: string;
  updatedAt: string;
}

export interface CreateIncidentResult {
  incident: Incident;
  created: boolean;
}

export type AuditActorType = "SYSTEM" | "GITHUB" | "USER" | "AGENT";

export interface AuditEventInput {
  idempotencyKey: string;
  incidentId: string;
  actorType: AuditActorType;
  actorId: string;
  eventType: string;
  metadata: Record<string, string | number | boolean | null>;
  occurredAt: string;
}
