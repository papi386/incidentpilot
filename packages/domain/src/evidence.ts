import type { Incident, TriggerType } from "./types";

export const EVIDENCE_KINDS = [
  "WORKFLOW_RUN",
  "WORKFLOW_JOB",
  "JOB_LOG_EXCERPT",
  "CHECK_RUN",
  "CHECK_OUTPUT",
  "CHANGED_FILE",
  "DIFF_HUNK",
  "ERROR_SIGNAL",
  "FAILING_TEST",
  "STACK_FRAME"
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EVIDENCE_SOURCE_KINDS = ["GITHUB_API", "GITHUB_REDIRECT", "DERIVED"] as const;
export type EvidenceSourceKind = (typeof EVIDENCE_SOURCE_KINDS)[number];

export const EVIDENCE_INTEGRITY = ["PROVIDER_AUTHENTICATED", "DERIVED_FROM_AUTHENTICATED"] as const;
export type EvidenceIntegrity = (typeof EVIDENCE_INTEGRITY)[number];

export const EVIDENCE_CONTENT_CLASSES = ["STRUCTURED_METADATA", "UNTRUSTED_TEXT"] as const;
export type EvidenceContentClass = (typeof EVIDENCE_CONTENT_CLASSES)[number];

export const EVIDENCE_SENSITIVITY = ["NORMAL", "POTENTIALLY_SENSITIVE"] as const;
export type EvidenceSensitivity = (typeof EVIDENCE_SENSITIVITY)[number];

export const EVIDENCE_EDGE_RELATIONS = ["DERIVED_FROM", "RELATED_TO", "POINTS_TO_FILE"] as const;
export type EvidenceEdgeRelation = (typeof EVIDENCE_EDGE_RELATIONS)[number];

export const EVIDENCE_COLLECTION_STATUSES = ["COMPLETED", "PARTIAL", "FAILED"] as const;
export type EvidenceCollectionStatus = (typeof EVIDENCE_COLLECTION_STATUSES)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue; }

export interface IncidentEvidenceContext {
  incident: Incident;
  provider: "github";
  repositoryExternalId: string;
  repositoryFullName: string;
  installationExternalId?: string;
  triggerType: TriggerType;
  triggerExternalId: string;
  baseSha?: string;
  headSha?: string;
}

export interface EvidenceDraft {
  dedupeKey: string;
  kind: EvidenceKind;
  sourceKind: EvidenceSourceKind;
  sourceExternalId?: string;
  sourceUrl?: string;
  integrity: EvidenceIntegrity;
  contentClass: EvidenceContentClass;
  sensitivity: EvidenceSensitivity;
  // External/repository/runtime content is evidence, never executable instruction.
  // This invariant is persisted so future prompt builders cannot silently upgrade it.
  instructionTrust: "NEVER_INSTRUCTIONS";
  content: string;
  contentSha256: string;
  metadata: JsonObject;
  collectedAt: string;
}

export interface EvidenceEdgeDraft {
  fromDedupeKey: string;
  toDedupeKey: string;
  relation: EvidenceEdgeRelation;
  metadata: JsonObject;
}

export interface EvidenceCollectionSummary {
  status: EvidenceCollectionStatus;
  requestsUsed: number;
  downloadedBytes: number;
  itemsProduced: number;
  edgesProduced: number;
  truncated: boolean;
  errorCodes: string[];
  baseResolution: "INCIDENT" | "WORKFLOW_PULL_REQUEST" | "HEAD_PARENT" | "UNAVAILABLE";
}

export interface EvidenceCollectionResult {
  items: EvidenceDraft[];
  edges: EvidenceEdgeDraft[];
  summary: EvidenceCollectionSummary;
}

export interface EvidenceCollectionRunInput {
  idempotencyKey: string;
  incidentId: string;
  source: "github";
  startedAt: string;
  completedAt: string;
  summary: EvidenceCollectionSummary;
}

export interface StoredEvidenceCollection {
  items: EvidenceDraft[];
  edges: EvidenceEdgeDraft[];
}
