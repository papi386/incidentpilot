import type {
  AggregateMetrics,
  EvaluationReport,
} from "./types";

export interface QualityRegressionPolicy {
  maximumAbsoluteDrop: number;
  maximumAbsoluteIncrease?: number;
  minimumComparableCases: number;
  metrics: Array<keyof Pick<
    AggregateMetrics,
    | "expectedOutcomeRate"
    | "rootCauseTop1Accuracy"
    | "rootCauseTop3Accuracy"
    | "meanEvidencePrecision"
    | "meanRequiredEvidenceRecall"
    | "abstentionRecall"
  >>;
  lowerIsBetterMetrics?: Array<keyof Pick<
    AggregateMetrics,
    | "meanBrierScore"
    | "expectedCalibrationError"
  >>;
}

export interface BaselineComparison {
  comparable: boolean;
  passed: boolean;
  failures: string[];
  deltas: Record<string, number | null>;
}

export function compareBaseline(
  current: EvaluationReport,
  baseline: EvaluationReport,
  policy: QualityRegressionPolicy,
): BaselineComparison {
  if (
    current.metrics.cases < policy.minimumComparableCases ||
    baseline.metrics.cases < policy.minimumComparableCases
  ) {
    return {
      comparable: false,
      passed: true,
      failures: ["NOT_ENOUGH_COMPARABLE_CASES"],
      deltas: {},
    };
  }

  const deltas: Record<string, number | null> = {};
  const failures: string[] = [];

  for (const metric of policy.metrics) {
    const currentValue = current.metrics[metric];
    const baselineValue = baseline.metrics[metric];

    if (currentValue === null || baselineValue === null) {
      deltas[metric] = null;
      continue;
    }

    const delta = currentValue - baselineValue;
    deltas[metric] = delta;

    if (delta < -policy.maximumAbsoluteDrop) {
      failures.push(`${metric}: ${delta.toFixed(4)}`);
    }
  }

  for (const metric of policy.lowerIsBetterMetrics ?? []) {
    const currentValue = current.metrics[metric];
    const baselineValue = baseline.metrics[metric];

    if (currentValue === null || baselineValue === null) {
      deltas[metric] = null;
      continue;
    }

    const delta = currentValue - baselineValue;
    deltas[metric] = delta;

    if (delta > (policy.maximumAbsoluteIncrease ?? policy.maximumAbsoluteDrop)) {
      failures.push(`${metric}: +${delta.toFixed(4)}`);
    }
  }

  return {
    comparable: true,
    passed: failures.length === 0,
    failures,
    deltas,
  };
}
