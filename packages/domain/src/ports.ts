import type {
  AuditEventInput,
  CreateIncidentResult,
  Incident,
  IncidentFailureCode,
  IncidentStatus,
  IncidentTrigger
} from "./types";
import type {
  EvidenceCollectionResult,
  EvidenceCollectionRunInput,
  EvidenceDraft,
  EvidenceEdgeDraft,
  IncidentEvidenceContext,
  StoredEvidenceCollection
} from "./evidence";

export interface IncidentStore {
  createOrGet(trigger: IncidentTrigger, dedupeKey: string): Promise<CreateIncidentResult>;
  getById(id: string): Promise<Incident | null>;
  updateStatus(id: string, next: IncidentStatus): Promise<void>;
  markFailedSafe(id: string, failureCode: IncidentFailureCode): Promise<boolean>;
}

export interface AuditLog {
  append(event: AuditEventInput): Promise<void>;
}

export interface WorkflowEngine {
  ensureIncidentWorkflow(incidentId: string): Promise<{ workflowId: string }>;
}

export interface IncidentContextStore {
  getEvidenceContext(incidentId: string): Promise<IncidentEvidenceContext | null>;
}

export interface IncidentAuthorizationDecision {
  allowed: boolean;
  reason: "AUTHORIZED_INSTALLATION" | "MISSING_INSTALLATION" | "UNKNOWN_INSTALLATION" | "INSTALLATION_SUSPENDED" | "INSUFFICIENT_PERMISSIONS" | "SUPERSEDED";
}

export interface IncidentAuthorizationPolicy {
  evaluate(incidentId: string): Promise<IncidentAuthorizationDecision>;
}

export interface EvidenceSource {
  collect(context: IncidentEvidenceContext): Promise<EvidenceCollectionResult>;
}

export interface EvidenceStore {
  saveCollection(
    run: EvidenceCollectionRunInput,
    items: EvidenceDraft[],
    edges: EvidenceEdgeDraft[]
  ): Promise<void>;
  loadCollection(incidentId: string): Promise<StoredEvidenceCollection>;
}

// Future-facing ports are defined now so infrastructure choices never become domain APIs.
export interface ModelRequest {
  role:
    | "triage"
    | "investigator"
    | "patcher"
    | "critic"
    | "authority-reviewer"
    | "skeptic";
  input: unknown;
  timeoutMs: number;
}

export interface ModelResponse {
  modelId: string;
  output: unknown;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  /** Physical provider calls represented by this response, including bounded repairs. */
  attempts?: number;
  /** Raw outputs for security evaluation of every represented attempt. */
  attemptOutputs?: unknown[];
  /** Invalid tool requests removed after the bounded repair attempt. */
  suppressedToolRequests?: number;
}

export interface ModelProvider {
  generate(request: ModelRequest): Promise<ModelResponse>;
}

export interface ObjectStore {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

export interface EventBus {
  publish(topic: string, payload: unknown, idempotencyKey: string): Promise<void>;
}

export type ExecutionCapability =
  | "TEST"
  | "BUILD"
  | "LINT"
  | "STATIC_ANALYSIS";

export interface ExecutionRequest {
  repository: string;
  sha: string;
  capability: ExecutionCapability;
  // Arguments are data for the trusted capability adapter. They are never a
  // shell command string and must not select a broader executable/capability.
  arguments: readonly string[];
  timeoutMs: number;
  networkPolicy: "DENY_ALL";
}

export interface ExecutionResult {
  exitCode: number;
  stdoutDigest: string;
  stderrDigest: string;
  durationMs: number;
}

export interface ExecutionBackend {
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}
