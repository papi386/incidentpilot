import type { ModelProvider, ModelRequest, ModelResponse } from "@incidentpilot/domain";

function phase(request: ModelRequest): string {
  if (request.input && typeof request.input === "object" && !Array.isArray(request.input)) {
    const value = (request.input as Record<string, unknown>).phase;
    return typeof value === "string" ? value : "";
  }
  return "";
}

export class ScriptedAgentModelProvider implements ModelProvider {
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const current = phase(request);
    let output: unknown;

    if (current === "TRIAGE") {
      output = {
        phase: "TRIAGE",
        summary: "The failing assertion is a symptom; compare the test contract with the changed API response and its last successful behavior.",
        hypotheses: [
          {
            id: "H1",
            failureClass: "UNIT_ASSERTION_REGRESSION",
            causeDescription: "The API status returned by changed source no longer matches the unit-test contract.",
            confidence: 0.62,
            evidenceIds: ["test-failure", "assertion", "diff-api"],
            falsifyingEvidence: ["The full diff shows no status-code change", "The prior successful run also returned 201"],
            status: "PLAUSIBLE",
          },
          {
            id: "H2",
            failureClass: "STALE_BUILD_ARTIFACT",
            causeDescription: "The test may be exercising stale generated output rather than the changed source.",
            confidence: 0.18,
            evidenceIds: ["job", "log"],
            falsifyingEvidence: ["The failure and source diff agree at the same head SHA"],
            status: "PLAUSIBLE",
          },
        ],
        toolRequests: [
          {
            tool: "READ_LOG_RANGE",
            target: "job-log-501",
            query: null,
            startLine: 116,
            endLine: 121,
            rationale: "Confirm expected/received values and the exact failing test location.",
          },
          {
            tool: "READ_DIFF",
            target: "src/api.ts",
            query: null,
            startLine: null,
            endLine: null,
            rationale: "Determine whether changed source introduced the observed response status.",
          },
          {
            tool: "COMPARE_BASELINE",
            target: "src/api.ts",
            query: null,
            startLine: null,
            endLine: null,
            rationale: "Discriminate a regression from pre-existing expected behavior.",
          },
        ],
        limitations: ["The retained excerpt is truncated."],
      };
    } else if (current === "VERIFY") {
      output = {
        phase: "VERIFY",
        summary: "The raw failure, changed source, and previous successful behavior agree on one causal chain.",
        hypotheses: [
          {
            id: "H1",
            failureClass: "UNIT_ASSERTION_REGRESSION",
            causeDescription: "src/api.ts changed the response from 200 to 201 while test/api.test.ts still requires 200.",
            confidence: 0.93,
            evidenceIds: ["observation-1", "observation-2", "observation-3"],
            falsifyingEvidence: ["Product requirements intentionally changed the endpoint contract to 201"],
            status: "SUPPORTED",
          },
          {
            id: "H2",
            failureClass: "STALE_BUILD_ARTIFACT",
            causeDescription: "Stale output is inconsistent with the direct source change and base-run comparison.",
            confidence: 0.04,
            evidenceIds: ["observation-2", "observation-3"],
            falsifyingEvidence: [],
            status: "REJECTED",
          },
        ],
        toolRequests: [],
        limitations: ["The intended product-level HTTP contract is not present in repository evidence."],
      };
    } else if (current === "CONCLUDE") {
      output = {
        outcome: "DIAGNOSIS_READY",
        summary: "A source change now returns HTTP 201 while the unit test and last successful baseline require HTTP 200.",
        hypotheses: [{
          causeCode: "UNIT_ASSERTION_REGRESSION",
          explanation: "The assertion, changed source diff, and base-run comparison form a consistent causal chain from the status-code edit to the failing test.",
          confidence: 0.93,
          evidenceIds: ["observation-1", "observation-2", "observation-3"],
          falsifyingEvidenceNeeded: ["Evidence that the endpoint contract was intentionally changed to HTTP 201"],
        }],
        recommendedChecks: [{
          capability: "TEST",
          arguments: ["test/api.test.ts"],
          rationale: "After reconciling the intended contract, rerun only the affected unit test.",
        }],
        limitations: ["Product intent cannot be inferred from CI evidence alone."],
      };
    } else {
      throw new Error(`Unexpected scripted agent phase: ${current}`);
    }

    return {
      modelId: "scripted-evidence-agent-demo",
      output,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
    };
  }
}
