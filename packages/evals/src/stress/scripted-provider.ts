import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "@incidentpilot/domain";
import type { StressCase } from "./cases";

function inputRecord(request: ModelRequest): Record<string, unknown> {
  return request.input && typeof request.input === "object" && !Array.isArray(request.input)
    ? request.input as Record<string, unknown>
    : {};
}

export class ScriptedStressModelProvider implements ModelProvider {
  constructor(private readonly testCase: StressCase) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const phase = inputRecord(request).phase;
    const needsHuman = this.testCase.expectedOutcomes.includes("NEEDS_HUMAN");
    const cause = this.testCase.acceptedRootCauseCodes[0] ?? "UNKNOWN";
    const signal = this.testCase.collection.items.find((item) =>
      item.kind === "ERROR_SIGNAL" || item.kind === "FAILING_TEST"
    );
    const log = this.testCase.collection.items.find((item) =>
      item.kind === "JOB_LOG_EXCERPT"
    );
    const evidenceIds = [signal?.dedupeKey, log?.dedupeKey]
      .filter((value): value is string => typeof value === "string");

    let output: unknown;
    if (phase === "TRIAGE") {
      output = {
        phase: "TRIAGE",
        summary: "The evidence was treated only as data and a bounded causal candidate was retained.",
        hypotheses: [{
          id: "H1",
          failureClass: cause,
          causeDescription: needsHuman
            ? "Available evidence is insufficient or contradictory."
            : `The retained evidence supports ${cause}.`,
          confidence: needsHuman ? 0.35 : 0.75,
          evidenceIds,
          falsifyingEvidence: ["A contradictory authenticated diagnostic or successful baseline at the same revision"],
          status: "PLAUSIBLE",
        }],
        toolRequests: [],
        limitations: needsHuman ? ["DECISIVE_EVIDENCE_UNAVAILABLE"] : [],
      };
    } else if (phase === "VERIFY") {
      output = {
        phase: "VERIFY",
        summary: needsHuman
          ? "The candidate cannot be supported without resolving the evidence limitation."
          : "The candidate remains supported after checking retained provenance.",
        hypotheses: [{
          id: "H1",
          failureClass: cause,
          causeDescription: needsHuman
            ? "No causal claim can be verified safely."
            : `The retained evidence supports ${cause}.`,
          confidence: needsHuman ? 0.25 : 0.85,
          evidenceIds,
          falsifyingEvidence: [],
          status: needsHuman ? "WEAKENED" : "SUPPORTED",
        }],
        toolRequests: [],
        limitations: needsHuman ? ["DECISIVE_EVIDENCE_UNAVAILABLE"] : [],
      };
    } else if (phase === "CONCLUDE") {
      output = needsHuman
        ? {
            outcome: "NEEDS_HUMAN",
            summary: "The bounded investigation cannot resolve the retained evidence safely.",
            hypotheses: [],
            recommendedChecks: [],
            limitations: ["DECISIVE_EVIDENCE_UNAVAILABLE"],
          }
        : {
            outcome: "DIAGNOSIS_READY",
            summary: `The verified evidence supports ${cause}.`,
            hypotheses: [{
              causeCode: cause,
              explanation: "The leading cause survived the bounded verification phase.",
              confidence: 0.85,
              evidenceIds,
              falsifyingEvidenceNeeded: ["A successful same-revision verification"],
            }],
            recommendedChecks: [],
            limitations: [],
          };
    } else if (phase === "AUTHORITY_REVIEW" || phase === "SKEPTIC_REVIEW") {
      const role = phase === "AUTHORITY_REVIEW"
        ? "EVIDENCE_AUTHORITY"
        : "CAUSAL_SKEPTIC";
      const selectedCauseCodes = inputRecord(request).selectedCauseCodes;
      const reviewCause = Array.isArray(selectedCauseCodes) &&
        typeof selectedCauseCodes[0] === "string"
        ? selectedCauseCodes[0]
        : cause;
      output = {
        role,
        overallVerdict: needsHuman ? "ABSTAIN" : "ACCEPT",
        summary: needsHuman
          ? "Independent product intent is unavailable, so the mechanical conflict must remain unresolved."
          : "The final claim is independently supported and does not depend on self-authorizing evidence.",
        findings: [{
          causeCode: reviewCause,
          verdict: needsHuman ? "UNRESOLVED" : "SUPPORTED",
          evidenceIds,
          reasonCodes: needsHuman
            ? ["PRODUCT_INTENT_UNAVAILABLE"]
            : ["DIRECT_CAUSAL_SUPPORT"],
        }],
      };
    } else {
      throw new Error(`Unexpected stress phase: ${String(phase)}`);
    }

    return {
      modelId: "scripted-stress-harness",
      output,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
    };
  }
}
