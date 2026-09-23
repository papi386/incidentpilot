import { describe, expect, it } from "vitest";
import { compareBaseline } from "../src/baseline";
import type { EvaluationReport } from "../src/types";

function report(top1: number): EvaluationReport {
  return {
    schemaVersion: 1,
    runId: "test",
    runKind: "LIVE_MODEL_EVALUATION",
    createdAt: "2026-09-21T00:00:00.000Z",
    modelIds: ["model"],
    promptVersions: ["prompt"],
    metrics: {
      cases: 40,
      modelCalls: 35,
      schemaValidityRate: 1,
      expectedOutcomeRate: 0.8,
      expectedModelCallRate: 1,
      rootCauseTop1Accuracy: top1,
      rootCauseTop3Accuracy: 0.9,
      meanBrierScore: 0.08,
      expectedCalibrationError: 0.05,
      meanEvidencePrecision: 0.9,
      meanRequiredEvidenceRecall: 0.9,
      abstentionRecall: 0.9,
      unknownCitationCount: 0,
      unauthorizedActionCount: 0,
      irrelevantRecommendationCount: 0,
      forbiddenClaimCount: 0,
      secretLeakageCount: 0,
      successfulInjectionCount: 0,
      meanLatencyMs: 10,
      p95LatencyMs: 20,
      inputTokens: 100,
      outputTokens: 50,
      estimatedCostUsd: null,
    },
    securityGate: { passed: true, failures: [] },
    cases: [],
  };
}

describe("baseline comparison", () => {
  it("reports observed regression without changing either result", () => {
    const comparison = compareBaseline(report(0.7), report(0.8), {
      maximumAbsoluteDrop: 0.03,
      minimumComparableCases: 20,
      metrics: ["rootCauseTop1Accuracy"],
    });

    expect(comparison.passed).toBe(false);
    expect(comparison.deltas.rootCauseTop1Accuracy).toBeCloseTo(-0.1);
  });

  it("treats worse calibration as a lower-is-better regression", () => {
    const current = report(0.8);
    current.metrics.meanBrierScore = 0.13;
    const baseline = report(0.8);
    baseline.metrics.meanBrierScore = 0.08;

    const comparison = compareBaseline(current, baseline, {
      maximumAbsoluteDrop: 0.03,
      maximumAbsoluteIncrease: 0.03,
      minimumComparableCases: 20,
      metrics: [],
      lowerIsBetterMetrics: ["meanBrierScore"],
    });

    expect(comparison.passed).toBe(false);
    expect(comparison.deltas.meanBrierScore).toBeCloseTo(0.05);
  });
});
