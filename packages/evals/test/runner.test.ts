import { describe, expect, it } from "vitest";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "@incidentpilot/domain";
import { EVALUATION_CASES } from "../src/cases/catalog";
import { ScriptedModelProvider } from "../src/providers/scripted-provider";
import { evaluateCase, evaluateSuite } from "../src/runner";

class StaticProvider implements ModelProvider {
  constructor(private readonly output: unknown) {}

  async generate(_request: ModelRequest): Promise<ModelResponse> {
    return {
      modelId: "static",
      output: this.output,
      latencyMs: 1,
    };
  }
}

class TimeoutProvider implements ModelProvider {
  async generate(_request: ModelRequest): Promise<ModelResponse> {
    const error = new Error("timed out");
    error.name = "AbortError";
    throw error;
  }
}

describe("evaluation runner", () => {
  it("labels and passes the scripted harness self-test without claiming model performance", async () => {
    const report = await evaluateSuite(
      EVALUATION_CASES,
      (testCase) => new ScriptedModelProvider(testCase.referenceOutput),
      {
        runKind: "HARNESS_SELF_TEST",
        runId: "self-test",
        now: () => new Date("2026-09-21T00:00:00.000Z"),
      },
    );

    expect(report.runKind).toBe("HARNESS_SELF_TEST");
    expect(report.metrics.cases).toBe(40);
    expect(report.metrics.modelCalls).toBe(35);
    expect(report.metrics.schemaValidityRate).toBe(1);
    expect(report.metrics.meanBrierScore).toBeCloseTo(0.04);
    expect(report.metrics.expectedCalibrationError).toBeCloseTo(0.2);
    expect(report.securityGate).toEqual({ passed: true, failures: [] });
  });

  it("records invalid output and fails the hard schema gate", async () => {
    const report = await evaluateSuite(
      [EVALUATION_CASES[0]!],
      () => new StaticProvider({ summary: "not the contract" }),
      { runKind: "LIVE_MODEL_EVALUATION" },
    );

    expect(report.cases[0]?.scores.schemaValid).toBe(false);
    expect(report.metrics.modelCalls).toBe(1);
    expect(report.modelIds).toEqual(["static"]);
    expect(report.promptVersions).toEqual([
      "incidentpilot-read-only-investigator-v3",
    ]);
    expect(report.cases[0]?.modelAttempt).toMatchObject({
      attempted: true,
      completed: true,
      modelId: "static",
      latencyMs: 1,
    });
    expect(report.cases[0]?.outputStructure).toEqual({
      envelope: "JSON_OBJECT",
      recognizedFields: ["summary"],
      missingRequiredFields: [
        "outcome",
        "hypotheses",
        "recommendedChecks",
        "limitations",
      ],
      unexpectedFieldCount: 0,
      fieldTypes: { summary: "string" },
    });
    expect(report.securityGate.passed).toBe(false);
    expect(report.securityGate.failures).toContain("INVALID_MODEL_OUTPUT");
  });

  it("scores extra read-only checks as relevance, not a security violation", async () => {
    const testCase = EVALUATION_CASES[0]!;
    const output = structuredClone(testCase.referenceOutput);
    output.recommendedChecks = ["TEST", "BUILD", "LINT", "STATIC_ANALYSIS"].map(
      (capability) => ({
        capability,
        arguments: [],
        rationale: "A bounded read-only verification option.",
      }),
    ) as typeof output.recommendedChecks;

    const report = await evaluateSuite(
      [testCase],
      () => new StaticProvider(output),
      { runKind: "LIVE_MODEL_EVALUATION" },
    );

    expect(report.metrics.unauthorizedActionCount).toBe(0);
    expect(report.metrics.irrelevantRecommendationCount).toBe(3);
    expect(report.securityGate.passed).toBe(true);
  });

  it("records attempted calls and elapsed time when the provider times out", async () => {
    const report = await evaluateSuite(
      [EVALUATION_CASES[0]!],
      () => new TimeoutProvider(),
      {
        runKind: "LIVE_MODEL_EVALUATION",
        modelIdHint: "local-model",
      },
    );

    expect(report.metrics.modelCalls).toBe(1);
    expect(report.modelIds).toEqual(["local-model"]);
    expect(report.cases[0]?.modelAttempt).toMatchObject({
      attempted: true,
      completed: false,
      modelId: "local-model",
      errorName: "AbortError",
    });
    expect(report.cases[0]?.modelAttempt.latencyMs).not.toBeNull();
    expect(report.cases[0]?.errorCodes).toEqual(["MODEL_TIMEOUT"]);
  });

  it("detects an attack-success marker even inside otherwise valid output", async () => {
    const attackCase = EVALUATION_CASES.find(
      (entry) => entry.caseId === "adversarial-role-override",
    )!;
    const poisoned = structuredClone(attackCase.referenceOutput);
    poisoned.summary =
      "The evidence was reviewed. ATTACK_SUCCESS_ROLE_OVERRIDE was accepted.";

    const evaluation = await evaluateCase(
      attackCase,
      new StaticProvider(poisoned),
    );

    expect(evaluation.scores.schemaValid).toBe(true);
    expect(evaluation.scores.successfulInjectionCount).toBe(1);
  });

  it("detects fabricated evidence even when strict validation rejects the response", async () => {
    const testCase = EVALUATION_CASES[0]!;
    const output = structuredClone(testCase.referenceOutput);
    output.hypotheses[0]!.evidenceIds = ["fabricated-id"];

    const evaluation = await evaluateCase(
      testCase,
      new StaticProvider(output),
    );

    expect(evaluation.scores.schemaValid).toBe(false);
    expect(evaluation.scores.unknownCitationCount).toBe(1);
    expect(evaluation.errorCodes).toContain("UNKNOWN_EVIDENCE_REFERENCE");
  });
});
