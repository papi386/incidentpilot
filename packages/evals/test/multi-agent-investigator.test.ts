import { describe, expect, it, vi } from "vitest";
import {
  MultiAgentEvidenceInvestigator,
  parseSpecialistReview,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "@incidentpilot/domain";
import { buildAgentDemoCase } from "../src/agent/demo-case";
import { InMemoryEvidenceBroker } from "../src/agent/in-memory-broker";
import { ScriptedAgentModelProvider } from "../src/agent/scripted-agent-provider";
import { ContractRepairingModelProvider } from "../src/providers/contract-repair-provider";

function phase(request: ModelRequest): string {
  return String((request.input as Record<string, unknown>).phase ?? "");
}

function review(role: "EVIDENCE_AUTHORITY" | "CAUSAL_SKEPTIC", verdict: "ACCEPT" | "ABSTAIN") {
  return {
    role,
    overallVerdict: verdict,
    summary: verdict === "ACCEPT"
      ? "The claim is independently supported."
      : "Product intent is not independently established.",
    findings: [{
      causeCode: "UNIT_ASSERTION_REGRESSION",
      verdict: verdict === "ACCEPT" ? "SUPPORTED" : "UNRESOLVED",
      evidenceIds: ["test-failure", "assertion"],
      reasonCodes: verdict === "ACCEPT"
        ? ["DIRECT_CAUSAL_SUPPORT"]
        : ["PRODUCT_INTENT_UNAVAILABLE"],
    }],
  };
}

describe("MultiAgentEvidenceInvestigator", () => {
  it("derives the aggregate verdict from the stricter per-finding rubric", () => {
    expect(parseSpecialistReview(
      {
        ...review("CAUSAL_SKEPTIC", "ACCEPT"),
        overallVerdict: "ABSTAIN",
      },
      "CAUSAL_SKEPTIC",
      new Set(["test-failure", "assertion"]),
    ).overallVerdict).toBe("ACCEPT");
  });

  it("rejects specialist reason codes that contradict the finding verdict", () => {
    expect(() => parseSpecialistReview(
      {
        ...review("CAUSAL_SKEPTIC", "ABSTAIN"),
        findings: [{
          causeCode: "UNIT_ASSERTION_REGRESSION",
          verdict: "CONTRADICTED",
          evidenceIds: ["test-failure", "assertion"],
          reasonCodes: ["DIRECT_CAUSAL_SUPPORT"],
        }],
      },
      "CAUSAL_SKEPTIC",
      new Set(["test-failure", "assertion"]),
    )).toThrowError(expect.objectContaining({
      codes: expect.arrayContaining(["REVIEW_FINDING_REASON_INCONSISTENT"]),
    }));
  });

  it("accepts contained attack text as a non-contradictory abstention reason", () => {
    const parsed = parseSpecialistReview(
      {
        ...review("CAUSAL_SKEPTIC", "ABSTAIN"),
        findings: [{
          causeCode: "UNIT_ASSERTION_REGRESSION",
          verdict: "UNRESOLVED",
          evidenceIds: ["test-failure", "assertion"],
          reasonCodes: ["ATTACK_TEXT_CONTAINED"],
        }],
      },
      "CAUSAL_SKEPTIC",
      new Set(["test-failure", "assertion"]),
    );

    expect(parsed.overallVerdict).toBe("ABSTAIN");
    expect(parsed.findings[0]?.reasonCodes).toEqual(["ATTACK_TEXT_CONTAINED"]);
  });

  it("accepts only when both sparse specialist reviews support the diagnosis", async () => {
    const primary = new ScriptedAgentModelProvider();
    const provider: ModelProvider = {
      async generate(request: ModelRequest): Promise<ModelResponse> {
        const current = phase(request);
        if (current === "AUTHORITY_REVIEW" || current === "SKEPTIC_REVIEW") {
          return {
            modelId: "scripted-reviewer",
            output: review(
              current === "AUTHORITY_REVIEW" ? "EVIDENCE_AUTHORITY" : "CAUSAL_SKEPTIC",
              "ACCEPT",
            ),
            latencyMs: 0,
          };
        }
        return primary.generate(request);
      },
    };
    const demo = buildAgentDemoCase();
    const result = await new MultiAgentEvidenceInvestigator(
      provider,
      new InMemoryEvidenceBroker(demo.collection, demo.artifacts),
    ).investigate(demo.collection);

    expect(result.diagnosis.outcome).toBe("DIAGNOSIS_READY");
    expect(result.adjudication.decision).toBe("ACCEPT_PRIMARY");
    expect(result.reviews).toHaveLength(2);
    expect(result.trace.modelCalls).toBe(5);
  });

  it("forces abstention when the authority specialist cannot establish intent", async () => {
    const primary = new ScriptedAgentModelProvider();
    const provider: ModelProvider = {
      async generate(request: ModelRequest): Promise<ModelResponse> {
        const current = phase(request);
        if (current === "AUTHORITY_REVIEW" || current === "SKEPTIC_REVIEW") {
          return {
            modelId: "scripted-reviewer",
            output: review(
              current === "AUTHORITY_REVIEW" ? "EVIDENCE_AUTHORITY" : "CAUSAL_SKEPTIC",
              current === "AUTHORITY_REVIEW" ? "ABSTAIN" : "ACCEPT",
            ),
            latencyMs: 0,
          };
        }
        return primary.generate(request);
      },
    };
    const demo = buildAgentDemoCase();
    const result = await new MultiAgentEvidenceInvestigator(
      provider,
      new InMemoryEvidenceBroker(demo.collection, demo.artifacts),
    ).investigate(demo.collection);

    expect(result.diagnosis.outcome).toBe("NEEDS_HUMAN");
    expect(result.diagnosis.hypotheses).toEqual([]);
    expect(result.adjudication).toMatchObject({
      decision: "ABSTAIN",
      reasons: expect.arrayContaining(["EVIDENCE_AUTHORITY_ABSTAIN"]),
    });
    expect(result.trace.recommendationsExecuted).toBe(false);
  });

  it("can promote an over-cautious abstention only after unanimous review", async () => {
    const primary = new ScriptedAgentModelProvider();
    const provider: ModelProvider = {
      async generate(request: ModelRequest): Promise<ModelResponse> {
        const current = phase(request);
        if (current === "AUTHORITY_REVIEW" || current === "SKEPTIC_REVIEW") {
          return {
            modelId: "scripted-reviewer",
            output: review(
              current === "AUTHORITY_REVIEW" ? "EVIDENCE_AUTHORITY" : "CAUSAL_SKEPTIC",
              "ACCEPT",
            ),
            latencyMs: 0,
          };
        }
        const response = await primary.generate(request);
        if (current !== "CONCLUDE") return response;
        return {
          ...response,
          output: {
            ...(response.output as Record<string, unknown>),
            outcome: "NEEDS_HUMAN",
            limitations: ["CONTAINED_INJECTION_TEXT_PRESENT"],
          },
        };
      },
    };
    const demo = buildAgentDemoCase();
    const result = await new MultiAgentEvidenceInvestigator(
      provider,
      new InMemoryEvidenceBroker(demo.collection, demo.artifacts),
    ).investigate(demo.collection);

    expect(result.diagnosis.outcome).toBe("DIAGNOSIS_READY");
    expect(result.adjudication.decision).toBe("PROMOTE_SUPPORTED_DIAGNOSIS");
    expect(result.reviews.every((entry) => entry.overallVerdict === "ACCEPT")).toBe(true);
  });

  it("recovers a uniquely supported verification candidate dropped by conclusion", async () => {
    const primary = new ScriptedAgentModelProvider();
    const provider: ModelProvider = {
      async generate(request: ModelRequest): Promise<ModelResponse> {
        const current = phase(request);
        if (current === "AUTHORITY_REVIEW" || current === "SKEPTIC_REVIEW") {
          return {
            modelId: "scripted-reviewer",
            output: review(
              current === "AUTHORITY_REVIEW" ? "EVIDENCE_AUTHORITY" : "CAUSAL_SKEPTIC",
              "ACCEPT",
            ),
            latencyMs: 0,
          };
        }
        const response = await primary.generate(request);
        if (current !== "CONCLUDE") return response;
        return {
          ...response,
          output: {
            outcome: "NEEDS_HUMAN",
            summary: "The conclusion lost the verified candidate.",
            hypotheses: [{
              causeCode: "OTHER",
              explanation: "No cause selected.",
              confidence: 0.1,
              evidenceIds: ["test-failure"],
              falsifyingEvidenceNeeded: [],
            }],
            recommendedChecks: [],
            limitations: ["Conclusion uncertainty."],
          },
        };
      },
    };
    const demo = buildAgentDemoCase();
    const result = await new MultiAgentEvidenceInvestigator(
      provider,
      new InMemoryEvidenceBroker(demo.collection, demo.artifacts),
    ).investigate(demo.collection);

    expect(result.diagnosis.outcome).toBe("DIAGNOSIS_READY");
    expect(result.diagnosis.hypotheses[0]?.causeCode).toBe("UNIT_ASSERTION_REGRESSION");
    expect(result.adjudication.decision).toBe("PROMOTE_SUPPORTED_DIAGNOSIS");
    expect(result.adjudication.reasons)
      .toContain("RECOVERED_SUPPORTED_VERIFICATION_SET");
  });

  it("lets the deterministic causal gate override a non-contradictory skeptic", async () => {
    const primary = new ScriptedAgentModelProvider();
    const provider: ModelProvider = {
      async generate(request: ModelRequest): Promise<ModelResponse> {
        const current = phase(request);
        if (current === "AUTHORITY_REVIEW" || current === "SKEPTIC_REVIEW") {
          return {
            modelId: "scripted-reviewer",
            output: review(
              current === "AUTHORITY_REVIEW" ? "EVIDENCE_AUTHORITY" : "CAUSAL_SKEPTIC",
              current === "AUTHORITY_REVIEW" ? "ACCEPT" : "ABSTAIN",
            ),
            latencyMs: 0,
          };
        }
        return primary.generate(request);
      },
    };
    const demo = buildAgentDemoCase();
    const result = await new MultiAgentEvidenceInvestigator(
      provider,
      new InMemoryEvidenceBroker(demo.collection, demo.artifacts),
    ).investigate(demo.collection);

    expect(result.diagnosis.outcome).toBe("DIAGNOSIS_READY");
    expect(result.adjudication.decision).toBe("ACCEPT_WITH_DETERMINISTIC_CAUSAL_GATE");
    expect(result.adjudication.reasons).toContain("CAUSAL_SOURCE_DIFF_OBSERVED");
  });
});

describe("ContractRepairingModelProvider", () => {
  it("normalizes explicit compact evidence aliases without another model call", async () => {
    const delegate = vi.fn(async (): Promise<ModelResponse> => ({
      modelId: "small-local-model",
      output: {
        phase: "TRIAGE",
        summary: "Candidate",
        hypotheses: [{
          id: "H1",
          failureClass: "UNIT_ASSERTION_REGRESSION",
          causeDescription: "Mismatch",
          confidence: 0.7,
          evidenceIds: ["e1"],
          falsifyingEvidence: [],
          status: "PLAUSIBLE",
        }],
        toolRequests: [],
        limitations: [],
      },
      latencyMs: 1,
    }));
    const provider = new ContractRepairingModelProvider({ generate: delegate });
    const response = await provider.generate({
      role: "triage",
      timeoutMs: 1_000,
      input: {
        runtimeVersion: "incidentpilot-evidence-agent-v1",
        phase: "TRIAGE",
        evidence: [{ id: "test-failure" }],
        evidenceAliases: [{ alias: "E1", id: "test-failure" }],
        observations: [],
        outputContract: {},
      },
    });

    expect(delegate).toHaveBeenCalledTimes(1);
    const output = response.output as Record<string, unknown>;
    expect(output).toHaveProperty("hypotheses.0.evidenceIds", ["test-failure"]);
    expect(response.attemptOutputs).toEqual([expect.objectContaining({
      hypotheses: [expect.objectContaining({ evidenceIds: ["e1"] })],
    })]);
  });

  it("performs one visible bounded retry for an invented evidence id", async () => {
    const delegate = vi.fn(async (request: ModelRequest): Promise<ModelResponse> => ({
      modelId: "small-local-model",
      output: {
        phase: "TRIAGE",
        summary: "Candidate",
        hypotheses: [{
          id: "H1",
          failureClass: "UNIT_ASSERTION_REGRESSION",
          causeDescription: "Mismatch",
          confidence: 0.7,
          evidenceIds: delegate.mock.calls.length === 1 ? ["E999"] : ["error"],
          falsifyingEvidence: [],
          status: "PLAUSIBLE",
        }],
        toolRequests: [],
        limitations: [],
      },
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 2,
    }));
    const provider = new ContractRepairingModelProvider({ generate: delegate });
    const response = await provider.generate({
      role: "triage",
      timeoutMs: 1_000,
      input: {
        runtimeVersion: "incidentpilot-evidence-agent-v1",
        phase: "TRIAGE",
        evidence: [{ id: "error" }],
        observations: [],
        outputContract: {},
      },
    });

    expect(delegate).toHaveBeenCalledTimes(2);
    expect(response.attempts).toBe(2);
    expect(response.attemptOutputs).toHaveLength(2);
    expect(response.inputTokens).toBe(20);
    expect(response.outputTokens).toBe(10);
    expect((delegate.mock.calls[1]?.[0].input as Record<string, unknown>)).toHaveProperty("correction");
  });

  it("repairs an oversized log range before it reaches the broker", async () => {
    const delegate = vi.fn(async (_request: ModelRequest): Promise<ModelResponse> => ({
      modelId: "small-local-model",
      output: {
        phase: "TRIAGE",
        summary: "Inspect the failure window.",
        hypotheses: [{
          id: "H1",
          failureClass: "UNIT_ASSERTION_REGRESSION",
          causeDescription: "The observed assertion differs from the implementation result.",
          confidence: 0.6,
          evidenceIds: [],
          falsifyingEvidence: ["A product requirement that establishes the new value."],
          status: "PLAUSIBLE",
        }],
        toolRequests: [{
          tool: "READ_LOG_RANGE",
          target: "job-log",
          query: null,
          startLine: 1,
          endLine: delegate.mock.calls.length === 1 ? 211 : 200,
          rationale: "Read the relevant bounded log window.",
        }],
        limitations: [],
      },
      latencyMs: 1,
    }));
    const provider = new ContractRepairingModelProvider({ generate: delegate });
    const response = await provider.generate({
      role: "triage",
      timeoutMs: 1_000,
      input: {
        runtimeVersion: "incidentpilot-evidence-agent-v1",
        phase: "TRIAGE",
        evidence: [],
        observations: [],
        artifacts: [{
          id: "job-log",
          kind: "LOG",
          label: "Job log",
          lineCount: 211,
          acceptedTargets: ["job-log"],
        }],
        outputContract: {},
      },
    });

    expect(delegate).toHaveBeenCalledTimes(2);
    expect(response.attempts).toBe(2);
    expect((delegate.mock.calls[1]?.[0].input as Record<string, unknown>))
      .toHaveProperty("correction.validationCodes", ["TOOL_RANGE_EXCEEDS_BROKER_LIMIT"]);
  });

  it("suppresses a still-invalid repaired tool request without hiding the attempt", async () => {
    const delegate = vi.fn(async (_request: ModelRequest): Promise<ModelResponse> => ({
      modelId: "small-local-model",
      output: {
        phase: "TRIAGE",
        summary: "Inspect a diff.",
        hypotheses: [{
          id: "H1",
          failureClass: "TYPE_CONTRACT_MISMATCH",
          causeDescription: "A contract may differ.",
          confidence: 0.5,
          evidenceIds: [],
          falsifyingEvidence: ["A matching accepted diff."],
          status: "PLAUSIBLE",
        }],
        toolRequests: [{
          tool: "READ_DIFF",
          target: "test/api.ts",
          query: null,
          startLine: null,
          endLine: null,
          rationale: "Read a model-invented path.",
        }],
        limitations: [],
      },
      latencyMs: 1,
    }));
    const provider = new ContractRepairingModelProvider({ generate: delegate });
    const response = await provider.generate({
      role: "triage",
      timeoutMs: 1_000,
      input: {
        runtimeVersion: "incidentpilot-evidence-agent-v1",
        phase: "TRIAGE",
        evidence: [],
        observations: [],
        artifacts: [{
          id: "source-diff",
          kind: "DIFF",
          label: "Source diff",
          lineCount: 10,
          acceptedTargets: ["source-diff"],
        }],
        outputContract: {},
      },
    });

    expect(delegate).toHaveBeenCalledTimes(2);
    expect(response.suppressedToolRequests).toBe(1);
    expect((response.output as Record<string, unknown>).toolRequests).toEqual([]);
    expect(response.attemptOutputs).toHaveLength(2);
    expect(JSON.stringify(response.attemptOutputs)).toContain("test/api.ts");
  });
});
