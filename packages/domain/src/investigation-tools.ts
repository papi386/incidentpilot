import type { JsonObject } from "./evidence";

export const READ_ONLY_EVIDENCE_TOOLS = [
  "SEARCH_EVIDENCE",
  "READ_LOG_RANGE",
  "FOLLOW_PROVENANCE",
  "READ_DIFF",
  "COMPARE_BASELINE",
] as const;

export type ReadOnlyEvidenceTool =
  (typeof READ_ONLY_EVIDENCE_TOOLS)[number];

export interface EvidenceToolDescriptor {
  name: ReadOnlyEvidenceTool;
  description: string;
}

export interface EvidenceArtifactDescriptor {
  id: string;
  acceptedTargets: string[];
  kind: "LOG" | "FILE" | "DIFF" | "BASELINE";
  label: string;
  lineCount: number | null;
}

/**
 * A single uniform request shape keeps model output easy to validate. Fields
 * that a tool does not use must be null; the broker remains authoritative.
 */
export interface EvidenceToolRequest {
  tool: ReadOnlyEvidenceTool;
  target: string | null;
  query: string | null;
  startLine: number | null;
  endLine: number | null;
  rationale: string;
}

export interface EvidenceToolResponse {
  content: string;
  sourceEvidenceIds: string[];
  truncated: boolean;
  metadata: JsonObject;
}

export interface EvidenceToolObservation extends EvidenceToolResponse {
  id: string;
  request: EvidenceToolRequest;
  instructionTrust: "NEVER_INSTRUCTIONS";
}

export interface ReadOnlyEvidenceBroker {
  describeTools(): readonly EvidenceToolDescriptor[];
  describeArtifacts(): readonly EvidenceArtifactDescriptor[];
  execute(request: EvidenceToolRequest): Promise<EvidenceToolResponse>;
}

/** A broker-side denial is evidence of policy enforcement, not a runtime crash. */
export class EvidenceToolPolicyError extends Error {
  constructor(readonly code: string) {
    super(`Evidence tool request denied: ${code}`);
    this.name = "EvidenceToolPolicyError";
  }
}
